
const {Pool} = require("./custom_pg.js");

const connection_cfg = {
    ...require("./test/db_connection.js"),

    // application_name?: string, // The name of the application that created this Client instance

    // connectionTimeoutMillis?: number, // number of milliseconds to wait for connection, default is no timeout
    /////connectionTimeoutMillis: 1000,

    // statement_timeout?: number, // number of milliseconds before a statement in query will time out, default is no timeout
    // query_timeout?: number, // number of milliseconds before a query call will timeout, default is no timeout
/////    query_timeout: 5100,

    // lock_timeout?: number, // number of milliseconds a query is allowed to be en lock state before it's cancelled due to lock timeout
    ////lock_timeout: 100, // ✅ No ens afecta.

    // idle_in_transaction_session_timeout?: number // number of milliseconds before terminating any session with an open idle transaction, default is no timeout
};

const pool = new Pool(connection_cfg);

pool.on('connect', function(client) {
    console.log(` 🔔 Connect: `); //, client);
});
pool.on('acquire', function(client) {
    console.log(` 🔔 Acquire: `); //, client);
});
pool.on('allErrors', function(err, client) {
    console.log(` 🔔🔔  Error: ${err.message}`); //, client);
});
// pool.on('error', function(err, client) {
//     console.log(` 🔔 Error: ${err.message}`); //, client);
// });
pool.on('release', function(err, client) {
    console.log(` 🔔 Release: ${err? err.message : "No Errors"}`); //, client);
});
pool.on('remove', function(client) {
    console.log(` 🔔 Remove: `); //, client);
});



const connections = [];


function wireConnection(c) {
    connections.push(c);
    ///console.log(`🔗 Wired new connection. Total: ${connections.length}`);
};

function failConnection(err) {
    ///console.error(`🔥 Failed wiring new connection: ${err.message}`);
    ///console.error(err);
};


function addConnection() {
    pool.connect().then(wireConnection).catch(failConnection);
};

addConnection();
addConnection();
addConnection();
addConnection();
addConnection();
addConnection();
addConnection();
addConnection();
addConnection();
addConnection();
addConnection();





function getPromiseState(promise) {
    const pending = {};
    return Promise.race([promise, pending])
        .then(
            value => (value === pending) ? 'pending' : 'fulfilled'
            , () => 'rejected'
        );
};


async function testConnection(c, label = "??", {secs = 5} = {}) {
    try {
        const {rows: [{t}]} = await c.query(
            "select now() as t from (select pg_sleep($1)) as foo"
            , [secs]
        );
        console.log(`✅ ${label}: ${t}`);
    } catch (err) {
        console.error(`❌ ${label}: Test Failed! ${err.message}`);
        console.error(err);
    };
};


module.exports = {
    pool,
    connections,
    getPromiseState,
    testConnection,
    addConnection,
};

