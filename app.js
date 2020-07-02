const express = require('express')
const bodyParser = require('body-parser');
const { v1: uuidv1 } = require('uuid');
const _ = require('underscore');
const redis = require("redis");
const Redlock = require('redlock');
const Scheduler = require('redis-scheduler');
const config = require('config');


const _notificationQueue = 'notification'
const _messageToSendQueue = 'messages_to_send'
const _checkLaterQueue = 'check_later_queue'
const _redisPort = config.get('redis.port');
const _redisHost = config.get('redis.host');
const _key = 'messages';
const jsonParser = bodyParser.json()


// init redis connections
const _redisClient = redis.createClient(_redisPort, _redisHost,function(err){
    next(err);
});
const _locker = new Redlock([_redisClient]);
const _scheduler = new Scheduler({ host: _redisHost, port: _redisPort },function(err){
    next(err);
});
const _checkLaterSubscriber = redis.createClient(_redisPort, _redisHost,function(err){
    next(err);
});
const _notificationsSubscriber = redis.createClient(_redisPort, _redisHost,function(err){
    next(err);
});

_locker.on('clientError', function (err) {
    console.error('A redis error has occurred:', err);
});

const app = express()
const port = 3000

const swaggerJSDoc = require('swagger-jsdoc');

const swaggerDefinition = {
    info: {
        title: 'Redis Assignment',
        version: '1.0.0',
        description: 'MoonActive',
    },
    host: 'localhost:3000',
    basePath: '/',
};

const options = {
    swaggerDefinition,
    apis: ['app.js'],
};
const swaggerSpec = swaggerJSDoc(options);

// -- routes for docs and generated swagger spec --

app.get('/swagger.json', (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.send(swaggerSpec);
});

app.get('/docs', (req, res) => {
    res.sendFile('redoc.html', { root: __dirname });

});

app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());
app.use(bodyParser.raw());

/**
 * @swagger
 * /api/v1/echoAtTime:
 *   post:
 *     summary: Add Message
 *     description: The message will be printed at the given time
 *                  this api call will use events to print the messages  
 *                  please note - messages must be in future time
 *     tags:
 *       - Echo at Time - V1
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               message:
 *                 type: string
 *                 required: true
 *                 example: "Hello World"
 *               date:
 *                  type: date
 *                  required: true
 *                  format: "MM-dd-yyyy HH:mm:ss"
 *                  example: "07-25-2020 14:15:00"
 *     responses:
 *       201:
 *         description: Adds the message into the queue
 *       400:
 *         description: Message time stamp is older than the current the time
 */
app.post('/api/v1/echoAtTime', jsonParser, function (req, res,next) {
    var requestedDate = new Date(req.body.date).getTime();
    // validate that the given date is in the future - if not return 400
    if (requestedDate < Date.now()) {
        res.status(400);
        next("Date is in the past")
    } else {
        try {
            var uuid = uuidv1();
            var json = JSON.stringify({ message: req.body.message, uuid: uuid, time:  res.body.date });
            _redisClient.zadd(_key, requestedDate, json, function (err) {
                if (err) {
                    next("Cannot Inset Value into Redis");
                }
            });
            //add expersion event 
            _scheduler.schedule({ key: json, expire: requestedDate - Date.now(), handler: eventTriggered }, function (err) {
                if (err) {
                    next("Error Adding Schedule Event");
                }
            });
        } catch (err) {
            next(err.message);
        }
        res.status(201).send();
        res.end();
    }
});


/**
 * @swagger
 * /api/v2/echoAtTime:
 *   post:
 *     summary: Add Message
 *     description: The message will be printed at the given time
 *                  this api call will use pulling and queues
 *                  please note - messages must be in future time
 *     tags:
 *       - Echo at Time - V2
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               message:
 *                 type: string
 *                 required: true
 *                 example: "Hello World"
 *               date:
 *                  type: date
 *                  required: true
 *                  format: "MM-dd-yyyy HH:mm:ss"
 *                  example: "07-25-2020 14:15:00"
 *     responses:
 *       201:
 *         description: Adds the message into the queue
 *       400:
 *         description: Message time stamp is older than the current the time
 */
app.post('/api/v2/echoAtTime', jsonParser, function (req, res,next) {
    var requestedDate = new Date(req.body.date).getTime();
    // validate that the given date is in the future - if not return 400
    if (requestedDate < Date.now()) {
        res.status(400);
        next("Date is in the past")
    } else {
        try {
            var uuid = uuidv1();
            var json = JSON.stringify({ message: req.body.message, uuid: uuid, time: req.body.date });
            _redisClient.zadd(_key, requestedDate, json, function (err) {
                if (err) {
                    next("Cannot Inset Value into Redis");
                }
            });
        } catch (err) {
            next(err.message);
        }
        res.status(201).send();
        res.end();
    }
});

function eventTriggered(err, key) {
    var res = JSON.parse(key);

    // lock the message in case other instance is warming up
    _locker.lock('lock:' + res.uuid, 1000).then(function (lock) {
        console.log(res.message+" "+res.time);
        _redisClient.zrem(_key, key);
        return lock.unlock()
            .catch(function (err) {
                console.error(err);
            });
    });
}

app.listen(port, function () {
    var now = Date.now();

    //"check later" subscriber will keep checking if there is a message with the current timestamp (+500 milli)
    // if there are messages to print it will try to lock them, remove them from the ZLIST, add them tho the worker queue and publish an event
    // for the worker to print the message
    _checkLaterSubscriber.subscribe(_checkLaterQueue);

    _checkLaterSubscriber.on('message', function (channel, message) {

        _redisClient.zrangebyscore(_key, Date.now(), Date.now() + 500, 'withscores', function (err, members) {
            var chunck = _.chunk(members, 2);
            chunck.forEach(element => {
                var res = JSON.parse(element[0]);
                // lock the message by uuid so no other service will be able to use it
                // if the lock can't be acquired it means that other instance already got it and will send it to the worker queue
                _locker.lock('lock:' + res.uuid, 1000).then(function (lock) {
                    _redisClient.lpush(_messageToSendQueue, element[0]);
                    publishMessage(_notificationQueue, 1);
                    _redisClient.zrem(_key, element[0]);
                    return lock.unlock()
                        .catch(function (err) {
                        });
                });
            });
        });
        // in any case - repopulate the queue for next iteration
        publishMessage(_checkLaterQueue, 1);

    });

    //notifcation subscriber will get notification to pop a message from the "messages_to_send" queue , will try to lock it and print the message to the console
    _notificationsSubscriber.subscribe(_notificationQueue);

    _notificationsSubscriber.on('message', function (channel, message) {
        //poping the first message in the queue
        _redisClient.lpop([_messageToSendQueue], function (err, reply) {
            if (reply != null) {
                var res = JSON.parse(reply);
                //try to accuire lock
                _locker.lock('lock:' + res.uuid, 1000).then(function (lock) {
                    console.log(res.message+" "+res.time);
                    return lock.unlock()
                        .catch(function (err) {
                        });
                });
            }
        });
    });

    // init the first iteration 
    publishMessage(_checkLaterQueue, 1);

    // check if there are messages in the queue that were not printed on time because the server was down
    // get all messages that are still availble in the queue that should've been sent by now
    // when all goes well this query should return 0 results as 
    // 1. there are messages in the queue but they will be sent in later time
    // 2. other instances already proceesed the messages on time
    _redisClient.zrangebyscore(_key, -1, now, 'withscores', function (err, members) {
        var chunck = _.chunk(members, 2);
        chunck.forEach(element => {
            var res = JSON.parse(element[0]);
            // lock the message by uuid so no other service will be able to use it
            // if the lock can't be acquired it means that other instance already got it and will print it
            _locker.lock('lock:' + res.uuid, 1000).then(function (lock) {
                console.log(res.message+" "+res.time);
                _redisClient.zrem(_key, element[0]);
                return lock.unlock()
                    .catch(function (err) {
                        console.error(err);
                    });
            });
        });
    });
});

// helper function to publish a message and close the connection
function publishMessage(queueName, msg) {
    var publisher = redis.createClient(_redisPort, _redisHost);
    publisher.publish(queueName, msg);
    publisher.quit();
}

