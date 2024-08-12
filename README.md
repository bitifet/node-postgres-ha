node-postgres-ha
================

High-Availability wrapper(s) over
[node-postgres](https://github.com/brianc/node-postgres).

-------------------------

*node-postgres-ha* is a wrapper over *node-postgres* implemented in order to
address some issues found while trying to improve application's resilience.

Many of those issues are:

  * Clients not being released after network issues (so that the pool may end
    up with no usable clients).

  * Clients can be queried after their *release()* method being called. Ok:
    they should not and, if so, it's not a node-postgres fault. But actively
    preventing it could avoid hard to debug issues in case of a client
    reference being accidentally kept.

  * Impossibility to detect network disconnection or high latency issues.
    - Specially with no connection timeout, in which case queries last forever
      because they are just awaiting in the pending queue.

  * (I'll complete the list as I remember...)


For now, node-postgres-ha oly provides an enhancenment for the *Pool* class
implemented as a wrapper over the original node-postgres' one.

Most, if not all, of the issues it tackles, would be better addressed as issues
/ PR's to the node-postgres repository itself. But that would have required a
lot of time.

By now, this wrapper solves the problem to me (and hopefully to other
people...) while, at the same time, it may serve as a cleaner base to reason
about each issue separately before moving them as issues and/or PRs to
mainstream node-postgres repository.


## Features 

  * Added new status() method to facilitate inspection.

```javascript
> pool.status()
{
  max: 4,
  used: 3,
  free: 1,
  alive: 3,
  defunct: 0,
  pending: 0,
  connErr: false
}
```

  * Emit an error event when the connect() method fails.

  * Created new "allErrors" event type that receive:

    - All the pool's error events.

    - All its clients error events (passing also the client).
                   
  * Implemented new recover() method to wisely attempt to free clients in ended state.


  * Added new option "autoRecover" (default false) which, if set to true, make
    that if a client acquisition fails, the recover() method automatically
    called and the client acquisition is retryed if succeed. It is also called
    on errors.

     
  * Implemented serverIsReachable() method to check network connectivity to the
    server.

  * Implemented a connection watching functionality that also maintain an
    internal "connectionError" flag that can be checked through the status()
    method.

  * Implemented the ability to remotely cancel disconnected queries from the
    server after connection recovery (avoiding resource wasting to the server).
    This must be activated throug the "autoCancel" option.


> 👉 Check [this repo commit
> messages](https://github.com/bitifet/node-postgres-ha/commits/main/) for more
> details...


## Setup

To use node-postgres-ha in your own project, follow below steps:

1. Install node-postgres-ha **AND** node-postgres:

```sh
npm install ha-pg pg
```

2. Use it in your code instead of original node-postgres:

> ℹ️  At least by now, *node-postgres-ha* only provides replacement for the *Pool*
> module of *node-postgres*.

```javascript
const {Pool} = require("ha-pg");
```

> ⚠️  Only promises API has been tested. If you want to use callbacks instead, try
> it at your own risk.



## Contributing

### Setting up for local development

  1. Clone the repo.

  2. Install actual node-postgres module with `npm install --no-save pg`.


> 📌 node-postgres-ha does NOT provide node-postgres as a dependency so that it
> not enforces any specific version.
> 
> That being said, it has been tested with version 8.12.0 connecting to a
> PostgreSQL 15.7 database.


  3. Ensure you have a PostgreSQL instance running with SSL enabled and an
     empty database for tests

  4. Ensure you have the proper [environment
     variables](https://www.postgresql.org/docs/current/libpq-envars.html#LIBPQ-ENVARS)
     configured for connecting to the instance.

  5. Run `npm run test` to run the tests.

  6. Additionally, you can also run the same tests using the original
     *node-postgres* instance you installed in step 2 with `npm run
     test_mainstream` to verify that they still DO NOT PASS in it.



## TO-DO

### Complete the tests

All forementioned features have been manually tested with the aid of [this
small tool](https://www.npmjs.com/package/netjam) among others.

For few of them I also implemented automated tests that can be passed both to
the original implementation and to the wrapper.

But those involving connection issues are harder to simulate. Even thought I
have ideas of how to address it but, for now, it's still pending...



## License

  [MIT](LICENSE)

