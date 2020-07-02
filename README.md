
# Delay Service

[![N|Solid](https://cldup.com/dTxpPi9lDf.thumb.png)](https://nodesource.com/products/nsolid)

Delay Service allows you to send a message in a given time in the future.
Don't worry, even if the service is down it will still print your messages when going back online in the same oreder as they were inserted 

#### tl;dr

For this project I used [ExpressJS](https://expressjs.com) and [Redis](https://redis.io) sorted sets, lists, pub/sub, locks and event listeners.
I used two approaches for delay queue management:
 - Pulling - using Redis as worker queue to pull messages that should be sent now
 - Event base -  using Redis's keyspace event notification in this case expiration events

The service has 2 endpints for each approch and it serves both as a    publisher and a subscriber

### In Depth
I used Redis's sorted set to save the messages payload setting the score as the message's timestamp (when the message should be printed). when a message is printed the service removes it from the set.
In this manner the service can get the messages by time range, this is useful on service warm up when it checks if there are dated messages in the set i.e. messages that should've been sent but there were no consumers to send them (dated messages are messages that their time stamp is older than the current time but are still on the queue)
It is also useful when pulling the queue for relevant messages.

The service works in two approaches to mange the delay queue

#### Pulling 
for this method I used Redis pub/sub, queue and sorted set. 

on start up, after printing dated messages (if any), the service subscribe to a "worker" queue for each event in that queue the service will try to query the sorted set for a message with the current time (+500 millisec).
The service will than publish a message to the worker queue for the next pulling iteration.

If there is a message(s) to send the service will push it into a queue, publish a message that there is a new message in the "message to be send" queue and will remove it from the set.

Using a list should ensure us that only one subscriber will pop the message from the top of the list, it also locks it by uuid to ensure that only one subscriber will print it. 

The service is both the publisher and the subscriber but I also added a subscriber.js.

[This is suggested on Redis's e-book](https://redislabs.com/ebook/part-2-core-concepts/chapter-6-application-components-in-redis/6-4-task-queues/6-4-2-delayed-tasks/)

#### Event Driven
Pulling is great but it also very heavy on the system as we keep querying Redis over and over.
Usually for those kind of offline tasks an event driven approach is more effective.
For this I used Redis's *[keyspace event notification](https://redis.io/topics/notifications)* in this case expiration events.

When a message is received from the API the service will add it to the sorted set but will also add a scheduled task for expiration event, when receiving the event the subscriber will print the message and will delete it from the set.
To ensure only one subscriber prints the message I used a lock on the message UUID. this is optimistic concurrency approach - only one will succeed to lock the message and other instances will fail


### Installation

For events driven the keyspace event notification should be set as follow on Redis startup (or added to redis.config)
please note: keyspace event notification has some overhead on Redis so it is disabled as default

    ./redis-server --notify-keyspace-events Ex


Install the dependencies and devDependencies and start the server.

```sh
npm install -d
node app
```
Set the configuration environment

     export NODE_ENV=local

#### Windows:

    setx NODE_ENV local
### Documentation
you can see the Service's API calls here:
[http://localhost:3000/doc](http://localhost:3000/doc)

### Known Issues (AKA things I should've done better)

 - The services is based on "Spaghetti Code" design pattern, i should've module the folders and files better
 - Redis connections- I might have handle Redis connection better, I used a single function to connect Redis each time it was needed, but I'm not sure I closed all the connections properly 
 - **TESTING!** 
### Blogs and Repositories 
 - [Redis keyspace event notification](http://blog.codezuki.com/blog/2013/07/07/redis-queue)
 - [Config file](https://codeburst.io/config-module-cleaner-way-to-write-nodejs-configuration-files-cd96ecffbde7)
 - [Delayed Tasks](https://redislabs.com/ebook/part-2-core-concepts/chapter-6-application-components-in-redis/6-4-task-queues/6-4-2-delayed-tasks/)
 - [RedisInsight](https://redislabs.com/redisinsight/)
 - [Publish/subscribe](https://redislabs.com/ebook/part-2-core-concepts/chapter-3-commands-in-redis/3-6-publishsubscribe/)
 - [Sorted Sets](https://redislabs.com/ebook/part-2-core-concepts/chapter-3-commands-in-redis/3-5-sorted-sets/)
 - [Lists](https://redislabs.com/ebook/part-2-core-concepts/chapter-3-commands-in-redis/3-2-lists/)
