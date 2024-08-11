
import node_postgres_ha from "../node_postgres_ha.js";
import assert from "assert";


// Handy method to glimpse client status;
const {clientStatus} = node_postgres_ha.Pool;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));



// Cancelling notes:
// -----------------
//
// const pid = pool._clients[0]?.processID  //-> Get remote PID.
//
// select pg_cancel_backend(pid); //-> Cancel query by connection PID.
//
// Checking cancellation:
//
// SELECT pid, state, query FROM pg_stat_activity WHERE pid = <PID>;



export default function deadPool_tests(poolName, {Pool}) {

    describe(`Testing ${poolName} implementation`, function() {
        let pool;
        let clients;


        beforeEach(async function() {//{{{
            pool = new Pool({
                max: 2, // Allow up to 2 clients.
            });
            clients = new Set();
        });//}}}

        afterEach(async function() {//{{{
            pool._pendingQueue.length = 0; // Truncate pending connection promises.
            for (const cl of pool._clients) { // Ensure all clients released:
                try {
                    await cl.release();
                } catch (err) {
                    // Just ensuring it is released
                };
            };
            try {
                await pool.end();
            } catch (err) {
                // Just ensuring it is released.
            };
        });//}}}


        // ✅ Already passing in original pg.Pool
        // ======================================

        false &&
        it('Should accept two concurrent clients', async function() {//{{{
            pool.connect().then(cl=>clients.add(cl));
            pool.connect().then(cl=>clients.add(cl));
            await sleep(50);
            assert.equal(clients.size, 2, "Clients 0 and 1 created");
            assert.equal(pool._clients.length, 2, "Pool has exactly 2 clients");
            assert.equal(
                [...clients].map(clientStatus).findIndex(cl=>!cl.queryable)
                , -1
                , "Both clinents are queryable"
            );
        });//}}}

        false &&
        it('Should accept more client requests', async function() {//{{{
            await pool.connect().then(cl=>clients.add(cl));
            await pool.connect().then(cl=>clients.add(cl));
            pool.connect().then(cl=>clients.add(cl)); await sleep(10);
            assert.equal(clients.size, 2, "Only 2 clients delivered");
            assert.equal(pool._clients.length, 2, "Pool has exactly 2 clients");
            assert.equal(pool._pendingQueue.length, 1, "Pool has exactly 1 pending clients to deliver");
        });//}}}

        false &&
        it('Should assign released clients', async function() {//{{{
            await pool.connect().then(cl=>clients.add(cl));
            await pool.connect().then(cl=>clients.add(cl));
            pool.connect().then(cl=>clients.add(cl)); await sleep(10);
            await [...clients][0].release();
            assert.equal(clients.size, 2, "Still only 2 different clients delivered");
            assert.equal(pool._clients.length, 2, "Pool still has exactly 2 clients");
            assert.equal(pool._pendingQueue.length, 0, "Now Pool has exactly 0 pending clients to deliver");
        });//}}}

        // ❌ Failing in original pg_pool
        // ==============================

        it('Client instance cannot be reused after releasing', async function() {//{{{
            const myClient = await pool.connect();
            myClient.release();
            let result = null;
            let gotcha = false;
            try {
                result = await myClient.query("select 'bar' as foo");
            } catch (err) {
                gotcha = true
            };
            assert.strictEqual(result, null, "Result cannot be obtained");
            assert.strictEqual(gotcha, true, "Error is thrown");
        });//}}}

        it('Should end with pendig client requests', async function() {//{{{
            await pool.connect().then(cl=>clients.add(cl));
            await pool.connect().then(cl=>clients.add(cl));
            pool.connect().then(cl=>clients.add(cl)); await sleep(10);
            assert.equal(clients.size, 2, "Only 2 clients delivered");
            assert.equal(pool._clients.length, 2, "Pool has exactly 2 clients");
            assert.equal(pool._pendingQueue.length, 1, "Pool has exactly 1 pending clients to deliver");
            await pool.end();
        });//}}}

        it('Should end with ongoing queries', async function() {//{{{
            // This test fails in original pg.Pool
            //
            // Just overloading the end() method for doing nothing misteriously
            // solves the problem (I don't know why):
            //
            // class Pool extends pg.Pool {
            //     async end(...args) {
            //         super.end(...args);
            //     };
            // };
            //
            await pool.connect().then(cl=>clients.add(cl));
            await pool.connect().then(cl=>clients.add(cl));
            const waitSeconds = 5;
            const t0 = Date.now();
            [...clients].forEach(
                cl=>cl.query("select pg_sleep($1)", [waitSeconds])
            );
            await pool.end();
            const elapsed = Date.now() - t0;
            assert(
                elapsed < waitSeconds * 1000
                , "Clients relased before query ends"
            );
        });//}}}

        it('Should detect errors on clients', async function() {//{{{

            let errorHappened = false;
            let errorDetected = false;

            const errHandler = err => errorDetected = true;
            pool.on("error", errHandler);
                // Just to establish it is not reported.
            pool.on("allErrors", errHandler);
                // Client errors will be mapped throug this new event.

            pool.on("error", function (err) {
                errorDetected = true;
            });

            pool.connect().then(cl=>clients.add(cl));
            pool.connect().then(cl=>clients.add(cl));
            await sleep(50);

            try {
                await [...clients][0].query("select willFail from nonexistent");
            } catch (err) {
                errorHappened = true;
            };

            assert.strictEqual(
                errorHappened
                , true
                , "Intentional error should happen"
            );
            assert.strictEqual(
                errorDetected
                , true
                , "Intentional error should be detected"
            );


        });//}}}

        //❓ Ongoing checking...
        // =====================

    });

};

