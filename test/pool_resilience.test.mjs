import assert from "assert";



import {sleep, E, waitFor, disconnect, isCancelled} from "./test_helpers.mjs";


export default function deadPool_tests(poolName, {Pool}) {

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

        it('Client instance cannot be reused after being released', async function() {//{{{
            createPool();
            const keptClient = await createClient();
            releaseClient(keptClient); // But we keep a reference
            await assert.rejects(
               async ()=>await keptClient.query("select now()")
               , E(/\.query is not a function/)
               , "Should throw when attempting to use released client."
            );
        });//}}}

        it('Pool should end with pendig client requests', async function() {//{{{
            createPool({
                max: 2, // Ensure maximum of 2 clients.
            });
            const resolveableClients = [
                createClient(),
                createClient(),
            ];
            const thirdClientPromise = createClient();
            await assert.equal(pool._pendingQueue.length, 1, "Pool has exactly 1 pending clients to deliver");
            await Promise.all(resolveableClients);
            await assert.equal(clients.length, 2, "We still have two client refereces");
            await pool.end(); // <--- This should resolve
        });//}}}

        it('Pool should end with ongoing queries', async function() {//{{{
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
            await assert(
                elapsed < waitSeconds * 1000
                , "Clients relased before query ends"
            );
        });//}}}

        it('Pool should detect errors on clients', async function() {//{{{
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

            await assert.strictEqual(
                errorHappened
                , true
                , "Intentional error should happen"
            );
            await assert.strictEqual(
                errorDetected
                , true
                , "Intentional error should be detected"
            );


        });//}}}

        it ("Config option 'autoRecover' works", async function() {//{{{
            createPool({autoRecover: true});
            const client1 = await createClient();
            const client2 = await createClient();
            await disconnect(client1);
            await assert.rejects(
                async ()=>await client1.query("seelect now()")
                , E(/connection terminated/i)
                , "Disconnected client throws on usage attempt"
            );
            await assert.doesNotReject(
                ()=>client2.query("select now()")
                , E(/./)
                , "Alive client does not throw"
            );
            const endedClients = pool._clients.filter(cl=>cl._ended).length;
            await assert(endedClients == 0, "No clients in ended status");
            await assert(await waitFor(createClient()), "New client can be obtained");
        });//}}}

        it ("Config option 'autoCancel' works", async function() {//{{{
            createPool({
                autoRecover: true,
                autoCancel: true,
                max: 2,
            });

            // Create two clients;
            const client1 = await createClient();
            const client2 = await createClient();

            const pid1 = client1?.processID;

            const long_run_query = client1.query("select pg_sleep(5)");

            await disconnect(client1);  // Simulate network disconnection

            await assert.rejects(
                long_run_query
                , E(/connection terminated/i)
                , "Query is rejected on network error"
            );

            await assert(
                ! await isCancelled(pid1)
                , "Not yet cancelled (we don't know if we could connect)"
            );

            await assert(
                await waitFor(createClient())
                , "New client can be obtained"
            );

            await assert(
                await isCancelled(pid1)
                , "First dispatched client used to effectively cancel pending query"
            );

        });//}}}


        //❓ Ongoing checking...
        // =====================



    });

};

