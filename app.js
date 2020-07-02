const express = require('express')
const bodyParser = require('body-parser');
const { v1: uuidv1 } = require('uuid');
const _ = require('underscore');
const redis = require("redis");
const Redlock = require('redlock');
const Scheduler = require('redis-scheduler');
const _key = 'messages';
const _notificationQueue = 'notification'
const _messageToSendQueue = 'messages_to_send'
const _checkLaterQueue = 'check_later_queue'
const config = require('config');
const _redisPort = config.get('redis.port');
const _redisHost = config.get('redis.host');

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

var jsonParser = bodyParser.json()

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
 *               time:
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
app.post('/api/v1/echoAtTime', jsonParser, function (req, res) {
    var requestedDate = new Date(req.body.date).getTime();
    // validate that the given date is in the future - if not return 400
    if (requestedDate < Date.now()) {
        res.status(400).send();
    } else {
        redisConnection((client, locker, scheduler) => {
            var uuid = uuidv1();
            var json = JSON.stringify({ message: req.body.message, uuid: uuid, time: requestedDate });
            client.zadd(_key, requestedDate, json);
            //add expersion event 
            scheduler.schedule({ key: json, expire: requestedDate - Date.now(), handler: eventTriggered }, function (err) {
            });
            client.quit();
            res.status(201).send('Event was added for, ' + requestedDate)
        });
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
 *               time:
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
app.post('/api/v2/echoAtTime', jsonParser, function (req, res) {
    var requestedDate = new Date(req.body.date).getTime();
    // validate that the given date is in the future - if not return 400
    if (requestedDate < Date.now()) {
        res.status(400).send
    } else {
        redisConnection((client, locker, scheduler) => {
            var uuid = uuidv1();
            var json = JSON.stringify({ message: req.body.message, uuid: uuid, time: requestedDate });
            client.zadd(_key, requestedDate, json);
            client.quit();
            res.status(201).send('Event was added for, ' + requestedDate)
        });

        res.status(200).send();
    }
});

function eventTriggered(err, key) {
    var res = JSON.parse(key);
    redisConnection((client, redlock) => {
        // lock the message in case other instance is warming up
        redlock.lock('lock:' + res.uuid, 1000).then(function (lock) {
            console.log(res.message);
            client.zrem(_key, key);
            return lock.unlock()
                .catch(function (err) {
                    console.error(err);
                }).then(() => { client.quit() })
        });

    });
}

app.listen(port, function () {
    var now = Date.now();

    //"check later" subscriber will keep checking if there is a message with the current timestamp (+500 milli)
    // if there are messages to print it will try to lock them, remove them from the ZLIST, add them tho the worker queue and publish an event
    // for the worker to print the message
    var CheckLaterSubscriber = redis.createClient(_redisPort, _redisHost);
    CheckLaterSubscriber.subscribe(_checkLaterQueue);

    CheckLaterSubscriber.on('message', function (channel, message) {
        redisConnection((client, locker) => {
            client.zrangebyscore(_key, Date.now(), Date.now() + 500, 'withscores', function (err, members) {
                var chunck = _.chunk(members, 2);
                chunck.forEach(element => {
                    var res = JSON.parse(element[0]);
                    // lock the message by uuid so no other service will be able to use it
                    // if the lock can't be acquired it means that other instance already got it and will send it to the worker queue
                    locker.lock('lock:' + res.uuid, 1000).then(function (lock) {
                        client.lpush(_messageToSendQueue, element[0]);
                        publishMessage(_notificationQueue, 1);
                        client.zrem(_key, element[0]);
                        return lock.unlock()
                            .catch(function (err) {
                            }).then(() => { client.quit() })
                    });
                });
            });

        })
        // in any case - repopulate the queue for next iteration
        publishMessage(_checkLaterQueue, 1);

    });

    //notifcation subscriber will get notification to pop a message from the "messages_to_send" queue , will try to lock it and print the message to the console
    var notificationsSubscriber = redis.createClient(_redisPort, _redisHost);
    notificationsSubscriber.subscribe(_notificationQueue);

    notificationsSubscriber.on('message', function (channel, message) {
        redisConnection((client, locker, scheduler) => {
            //poping the first message in the queue
            client.lpop([_messageToSendQueue], function (err, reply) {
                if (reply != null) {
                    var res = JSON.parse(reply);
                    //try to accuire lock
                    locker.lock('lock:' + res.uuid, 1000).then(function (lock) {
                        console.log(res.message);
                        return lock.unlock()
                            .catch(function (err) {
                            }).then(() => { client.quit() })
                    });
                }
            });
        });
    });

    // init the first iteration 
    publishMessage(_checkLaterQueue, 1);

    // check if there are messages in the queue that were not printed on time because the server was down
    redisConnection((client, locker) => {
        // get all messages that are still availble in the queue that should've been sent by now
        // when all goes well this query should return 0 results as 
        // 1. there are messages in the queue but they will be sent in later time
        // 2. other instances already proceesed the messages on time
        client.zrangebyscore(_key, -1, now, 'withscores', function (err, members) {
            var chunck = _.chunk(members, 2);
            chunck.forEach(element => {
                var res = JSON.parse(element[0]);
                // lock the message by uuid so no other service will be able to use it
                // if the lock can't be acquired it means that other instance already got it and will print it
                locker.lock('lock:' + res.uuid, 1000).then(function (lock) {
                    console.log(res.message);
                    client.zrem(_key, element[0]);
                    return lock.unlock()
                        .catch(function (err) {
                            console.error(err);
                        }).then(() => { client.quit() })
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

//helper function for redis connection 
function redisConnection(redisFunction) {
    var client = redis.createClient(_redisPort, _redisHost);
    var redlock = new Redlock([client]);
    var scheduler = new Scheduler({ host: _redisHost, port: _redisPort });
    redlock.on('clientError', function (err) {
        console.error('A redis error has occurred:', err);
    });
    try {
        redisFunction(client, redlock, scheduler);
    } catch (err) {
        console.log(err.toString());
    } finally {

    }
}

