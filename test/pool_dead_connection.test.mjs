
import node_postgres_ha from "../node_postgres_ha.js";
import assert from "assert";



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


    // Miscellaneous helpers:
    // ----------------------

    const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

    // Check for an (un)expected error:
    const E = pattern => err => {
        // Test for expected error:
        if (err.message.match(pattern)) return true;
        throw err; // Rethrow so we can see the actual error
    };

    // Wait for a promise to resovle:
    const waitFor = async (p, ms = 100)=>{
        let resolved = false;
        return await Promise.race([
            p.then(()=>true), // Don't catch (errors not expected here)
            sleep(ms).then(()=>false),
        ]);
    };

    // Simulate connection failure for given client(s):
    async function disconnect(...clients) {
        return await Promise.all(
            clients.map(cl=>cl.connection.stream.destroy())
        );
    };


    async function isCancelled(pid) {
        const p = new Pool({allowExitOnIdle: true});
        const {rows: [{cancelled}]} = await p.query(
            "SELECT count(1) = 0 as cancelled FROM pg_stat_activity WHERE pid = $1"
            , [pid]
        );
        p.end();
        return cancelled;
    };







    describe(`Testing ${poolName} implementation`, function() {
        let pool;
        let clients = [];


        beforeEach(async function() {//{{{
            clients.length = 0;
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

        function createPool(options = {}) {//{{{
            pool = new Pool({
                // Default options
                max: 2, // Allow up to 2 clients.
                allowExitOnIdle: true,
                // Per-test options:
                ...options
            });
        };//}}}

        async function createClient() {//{{{
            const newClient = await pool.connect();
            clients.push(newClient);
            return newClient;
        };//}}}

        function releaseClient(client) {//{{{
            const clientPosition = clients.findIndex(cl=>Object.is(cl, client));
            client.release();
            clients.splice(clientPosition, 1); // (-1 removves last)
        };//}}}


        // ❌ Failing in original pg_pool
        // ==============================

        it('Client instance cannot be reused after releasing', async function() {//{{{
            createPool();
            const keptClient = await createClient();
            releaseClient(keptClient); // But we keep a reference
            let result = null;
            let gotcha = false;
            try { // Should throw when attempting to use released client:
                result = await keptClient.query("select 'bar' as foo");
            } catch (err) {
                gotcha = true
            };
            assert.strictEqual(result, null, "Result cannot be obtained");
            assert.strictEqual(gotcha, true, "Error is thrown");
        });//}}}

        it('Should end with pendig client requests', async function() {//{{{
            createPool({
                max: 2, // Ensure maximum of 2 clients.
            });
            const resolveableClients = [
                createClient(),
                createClient(),
            ];
            const thirdClientPromise = createClient();
            assert.equal(pool._pendingQueue.length, 1, "Pool has exactly 1 pending clients to deliver");
            await Promise.all(resolveableClients);
            assert.equal(clients.length, 2, "We still have two client refereces");
            await pool.end(); // <--- This should resolve
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
            createPool();
            await createClient();
            await createClient();
            const waitSeconds = 5;
            const t0 = Date.now();
            clients.forEach(
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
            createPool();

            let errorHappened = false;
            let errorDetected = false;

            const errHandler = err => errorDetected = true;
            pool.on("error", errHandler);
                // Just to establish it is not reported.
            pool.on("allErrors", errHandler);
                // Client errors will be mapped through this new event.

            pool.on("error", function (err) {
                errorDetected = true;
            });

            await createClient();
            await createClient();

            try {
                await [...clients][0].query("INVALID SQL QUERY");
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

        it ("autoRecover works", async function() {//{{{
            createPool({autoRecover: true});
            const client1 = await createClient();
            const client2 = await createClient();
            await disconnect(client1);
            await assert.rejects(
                ()=>client1.query("seelect now()")
                , E(/connection terminated/i)
                , "Disconnected client throws on usage attempt"
            );
            await assert.doesNotReject(
                ()=>client2.query("select now()")
                , E(/./)
                , "Alive client does not throw"
            );
            const endedClients = pool._clients.filter(cl=>cl._ended).length;
            assert(endedClients == 0, "No clients in ended status");
            assert(await waitFor(createClient()), "New client can be obtained");
        });//}}}


        //❓ Ongoing checking...
        // =====================



    });

};

