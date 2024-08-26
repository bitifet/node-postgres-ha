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
            if (pool) {
                pool._pendingQueue.length = 0; // Truncate pending connection promises.
                for (const cl of pool._clients) { // Ensure all clients released:
                    try {
                        await cl.release();
                    } catch (err) {
                        // Just ensuring it is released
                    };
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


        // 👀 Should keep working in ha-pg
        // ==============================
        it('Pool exts cleanly', async function() {
            const pool = new Pool();
            await assert(await waitFor(pool.end()), "pool.end() resolves.");
        });

        

        // ❌ Failing in original pg_pool
        // ==============================

        it('Client instance cannot be reused after being released'//{{{
            , async function() {
                createPool();
                const keptClient = await createClient();
                releaseClient(keptClient); // But we keep a reference
                await assert.rejects(
                async ()=>await keptClient.query("select now()")
                , E(/\.query is not a function/)
                , "Should throw when attempting to use released client."
                );
            }
        );//}}}

        it('Pool should NOT end with ongoing queries'//{{{
            , async function() {
                // ⚠️  This test (originally claiming pool should exit) was
                // originally a mistake
                //
                // 👉 Obviously pools should NOT end until all clients released!!!
                //
                // There was no "mistery": Just I neglected to await when calling
                // parent's end() method (that's why "overloading the end() method
                // for doing nothing misteriously solved it").
                //
                // 👉 BUT: There must be a mechanism to forcibly end in case of
                // clients not being released (i.e. if connection goes down...).

                createPool();
                await createClient();
                await createClient();
                const waitSeconds = .01;
                const t0 = Date.now();
                const ongoingQueries = Promise.all(clients.map(
                    cl=>cl.query("select pg_sleep($1)", [waitSeconds])
                ));
                let poolEnded = false;
                pool.end().then(()=>poolEnded = true);
                sleep(.01);
                await assert.equal(
                    poolEnded
                    , false
                    , "Pool does not end before clients being released"
                );
                await ongoingQueries;

                const elapsed = Date.now() - t0;
                await assert(
                    elapsed >= waitSeconds
                    , "Clients relased only after query ends"
                );
                await assert.equal(
                    poolEnded
                    , false
                    , "Pool finally released"
                );
            }
        );//}}}

        it('Pool should end with pendig client requests'//{{{
            , async function() {
                createPool({
                    max: 2, // Ensure maximum of 2 clients.
                });
                const resolveableClients = [
                    createClient(),
                    createClient(),
                ];

                let thirdClientResolved = false;
                createClient() // This goes to _pendingQueue
                    .then(()=>thirdClientResolved = true)
                ;
                await assert.equal(
                    pool._pendingQueue.length
                    , 1
                    , "Pool has exactly 1 pending clients to deliver"
                );
                await Promise.all(resolveableClients); // Clients assigned.
                await assert.equal(
                    clients.length
                    , 2
                    , "We still have two client refereces"
                );
                let poolEnded = false;
                const poolEndPromise = pool.end().then(()=>poolEnded = true).catch(console.error);
                sleep(.01);
                await assert.equal(
                    poolEnded
                    , false
                    , "Pool does not end before clients being released"
                );
                // Release in-use clients after pool.end() requested.
                await Promise.all(clients.map(cl=>cl.release()));
                await poolEndPromise;
                await assert.equal(
                    poolEnded
                    , true
                    , "Pool ended after clients release"
                );
                await assert.equal(
                    thirdClientResolved
                    , false
                    , "Third client does not yet resolve"
                );
            }
        );//}}}

        it('Pool should detect errors on clients'//{{{
            , async function() {
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

            }
        );//}}}

        it ("Config option 'autoRecover' works"//{{{
            , async function() {
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
            }
        );//}}}

        it ("Config option 'autoCancel' works"//{{{
            , async function() {
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

            }
        );//}}}

        it( 'Can finish with idle but non ended clients if timed out'//{{{
            , async function () {
                createPool({
                    client_timeout: 10,
                })
                const client = await pool.connect()
                await pool.end()
            }
        )//}}}

        it( 'Even timed out clients are awaited for idle state'//{{{
            , async function () {
                createPool({
                    client_timeout: 1,
                })
                let queryCompleted = false;
                pool
                    .query("select pg_sleep($1)", [.004])
                    .then(()=>queryCompleted = true)
                ;
                await sleep(.002); // Let client to timout
                await assert(
                    pool.status(true).clients[0].timedOut
                    , "Client is timed out"
                );
                await assert(
                    ! queryCompleted
                    , "Query is still in progress"
                );
                await pool.end();
                await assert(
                    queryCompleted
                    , "Query was awaited for completion before pool end"
                );
            }
        )//}}}


        //❓ Ongoing checking...
        // =====================


    });

};

