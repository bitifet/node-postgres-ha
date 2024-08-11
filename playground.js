
const {Pool} = require("./node_postgres_ha.js");

const connection_cfg = {

    autoRecover: true, // Enable our high availability feature!
    autoCancel: true,

    max: 4,


    // application_name?: string, // The name of the application that created this Client instance

    // connectionTimeoutMillis?: number, // number of milliseconds to wait for connection, default is no timeout
    /////connectionTimeoutMillis: 1000,

    // statement_timeout?: number, // number of milliseconds before a statement in query will time out, default is no timeout
////statement_timeout: 5000,
    // query_timeout?: number, // number of milliseconds before a query call will timeout, default is no timeout
 ////  query_timeout: 5100,

    // lock_timeout?: number, // number of milliseconds a query is allowed to be en lock state before it's cancelled due to lock timeout
    ////lock_timeout: 100, // ✅ No ens afecta.

    // idle_in_transaction_session_timeout?: number // number of milliseconds before terminating any session with an open idle transaction, default is no timeout
};

const pool = new Pool(connection_cfg);

false &&
pool.on('ready', function(ev) {
    console.log(` 🔔 Ready!!!: `, ev.message); //, client);
});

false &&
pool.on('allErrors', function(err, client) {
    console.log(` 🔔${client ? "🔔" : "-"}  Error: ${err.message}`); //, client);
});

false &&
pool.on('connect', function(client) {
    console.log(` 🔔 Connect: `); //, client);
});
false &&
pool.on('acquire', function(client) {
    console.log(` 🔔 Acquire: `); //, client);
});

false &&
pool.on('error', function(err, client) {
    console.log(` 🔔 Error: ${err.message}`); //, client);
});
false &&
pool.on('release', function(err, client) {
    console.log(` 🔔 Release: ${err? err.message : "No Errors"}`); //, client);
});
false &&
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

// addConnection();
// addConnection();
// addConnection();
// addConnection();
// addConnection();
// addConnection();





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

function query(...args) {

    pool.query(...args)
        .then(({rows})=>console.log("✅", rows))
        .catch(err=>console.error("❌", err.message))
    ;

};


module.exports = {
    pool,
    query,
    connections,
    getPromiseState,
    testConnection,
    addConnection,
};

