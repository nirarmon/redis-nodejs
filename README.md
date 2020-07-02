# Delay Service

[![N|Solid](https://cldup.com/dTxpPi9lDf.thumb.png)](https://nodesource.com/products/nsolid)

[![Build Status](https://travis-ci.org/joemccann/dillinger.svg?branch=master)](https://travis-ci.org/joemccann/dillinger)

Delay Service allows you to send a message in a given time in the future.
Don't worry, even if the service is down it will still print your messages when going back online in the same oreder as they were inserted 

#### tl;dr

For this project I used [Express] and [Redis] sorted sets, queues, pub/sub, locks and event listeners
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