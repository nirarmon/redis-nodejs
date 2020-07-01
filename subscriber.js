const { v1: uuidv1 } = require('uuid');
const _ = require('underscore');
const redis = require("redis");
const Redlock = require('redlock');
const Scheduler = require('redis-scheduler');

var subscriber = redis.createClient(7001, "10.30.22.42");

subscriber.on('message', function (channel, message) {
    redisConnection((client, locker, scheduler) => {
        //poping the first message in the queue
        client.lpop(['messages_to_send'], function (err, reply) {
            if (reply != null) {
                var res = JSON.parse(reply);
                //try to accuire lock
                locker.lock('lock:' + res.uuid, 1000).then(function (lock) {
                    console.log(res.message);
                    return lock.unlock()
                        .catch(function (err) {
                        });
                });
            }
        });
    });

});

subscriber.subscribe('notification');

function redisConnection(redisFunction) {
    var client = redis.createClient(7001, "10.30.22.42");
    var redlock = new Redlock([client]);
    var scheduler = new Scheduler({ host: "10.30.22.42", port: 7001 });
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