
const pg = require("pg");
const net = require("net");

const PING_MESSAGE = Buffer.from([
    0x00, 0x00, 0x00, 0x08, // Packet length
    0x00, 0x00, 0x00, 0x00  // Non existent Postgres version
]);
const PONG_PATTERN = "SFATAL";
const PING_TIMEOUT = 1000; // Maximum ms to wait for ping connection.

const clientIsDefunct = cl => !!cl._ended;
const clientIsIdle = cl => !cl.activeQuery && !cl.queryQueue.length;
const clientIsTimedOut = cl => !!(
    cl.connectionParameters.client_timeout
    && (Date.now() - cl.ctime) > cl.connectionParameters.client_timeout
);

const coalesce = (...args)=>args.find(x=>x!==undefined);

class Pool extends pg.Pool {

    // Overload Client implementation
    constructor({//{{{
        autoRecover = false,   // Auto-vacuum defunct clients.
        autoCancel = false,    // Attempt to remote cancel defunct client's queries.
        reconnectInterval = 5000,
        ...options
    } = {}, ...args) {
        super(options, ...args);
        this.autoRecover = !! autoRecover;
        this.autoCancel = !! autoCancel;
        this.reconnectInterval = Number(reconnectInterval);
        this.defunctPIDs = [];
        this.connectionError = false;
        this.connectionWatcher = null;

        // Implement allErrors event:{{{
        // --------------------------
        const baseClient = this.Client;
        const parentPool = this;
        this.Client = class extendedClient extends baseClient {
            constructor(cfg, ...args) {
                super(cfg, ...args);
                const client_timeout = coalesce(
                    cfg.client_timeout
                    , parentPool.options.client_timeout
                );

                if (client_timeout !== undefined) {
                    this.connectionParameters.client_timeout = client_timeout;
                };


                this.ctime = Date.now();
                this.on("error", err => parentPool.emit("allErrors", err, this)); 
            };
            async query(...args) {
                try {
                    return await super.query(...args);
                } catch (err) {
                    this.emit("error", err);
                    throw err;
                };
            };
        };
        this.on("error", (...args) => this.emit("allErrors", ...args));
        // --------------------------}}}

        if (this.autoRecover) {
            let recovering = false;
            this.on("allErrors", async ()=>{
                if (! recovering) {
                    recovering = true;
                    await this.recover();
                    recovering = false;
                };
            });
        };

        this.watchForConnection();
        this.on("allErrors", this.watchForConnection.bind(this));

    };//}}}

    // Add static method to extract client overall status:
    static clientStatus(c) {//{{{
        const {
            _connecting,
            _connected,
            _ending,
            _ended,
            _connectionError,
            _queryable,
            queryQueue,
        } = c;
        return {
            connecting      : !! _connecting,
            connected       : !! _connected,
            ending          : !! _ending,
            ended           : !! _ended,
            connectionError : !! _connectionError,
            queryable       : !! _queryable,
            pendingQueries  : queryQueue.length,
            idle            : clientIsIdle(c),
            timedOut        : clientIsTimedOut(c),
        };
    };//}}}

    // Add method to retrieve overall pool status:
    status(showClients = false) {//{{{
        const max = this.options.max;
        const used = this._clients.length;
        const free = max - used;
        const pending = this._pendingQueue.length;
        const defunct = this._clients.filter(clientIsDefunct).length;
        const idle = this._clients.filter(clientIsIdle).length;
        const alive = this._clients.length - defunct;
        const timedOut = this._clients.filter(clientIsTimedOut).length;
        return {
            max,
            used,
            free,
            idle,
            alive,
            timedOut,
            defunct,
            pending,
            connErr: this.connectionError,
            ...(
                showClients ? {
                    clients: this._clients.map(this.constructor.clientStatus)
                }
                : {}
            ),
        };
    };//}}}

    // Overload connect() method to:
    //   - Capture failed connection attempt errors.
    //   - Return a proxy preventing client access after releasing.
    async connect(...args) {//{{{
        try {
            let client = await super.connect(...args);
            let released = false;
            if (
                ! client // No available clients
                && this.autoRecover
                && await this.recover()
            ) {
                // Try again...
                client = await super.connect(...args);
            };

            if (! client) return; // Couldn't obtain new one

            client.ctime = Date.now(); // Renew ctime every time reused.

            // Proxy-wrap:
            client = new Proxy(client, {
                get(target, prop, receiver) {
                    const value = Reflect.get(target, prop, receiver);
                    if (
                        typeof value === 'function'
                        && prop === "release"
                    ) {
                        return function(...args) {
                            released = true;
                            return value.apply(this, args);
                        }
                    } else if (released) {
                        return undefined; // Disallow accesses after releasing.
                    };
                    return value;
                },
                set(target, prop, value, receiver) {
                    if (released) return false; // Dissallow any access after releasing.
                    return Reflect.set(target, prop, value, receiver);
                }
            });

            if (
                this.autoCancel
                && this.defunctPIDs.length
            ) {
                for (let pid of this.defunctPIDs) {
                    try {
                        void await client.query(
                            "SELECT pg_cancel_backend($1);"
                            , [pid]
                        );
                    } catch (err) {}; // (Just attempt)
                };
                this.defunctPIDs.length = 0;
            };

            return client;

        } catch (err) {
            // Emit failed connection attempt errors.
            this.emit("error", err, null);
            throw err;
        };
    };//}}}

    // Implement our own query method since parent's once rely in original
    // client implementation.
    async query(...args) {//{{{
        /// // It was too beautiful to be real:
        /// return super.query.apply(this, args);
        let retval;
        const client = await this.connect();
        try {
            retval = await client.query(...args);
        } catch (err) {
            try {
                client.release();
                // One may think we don't need to capture errors over query
                // execution since it will be automatically done by calling
                // recover() on error events.
                // BUT this only happen if the client goes to the ended state
                // (typically due to connection errors). NOT due to regular
                // errors such as statement error.
            } catch (err) { /* Just attempt */ };
            throw err; // Throw original error instead.
        };
        client.release();
        return retval;
    };//}}}

    async end(...args) {//{{{
        while (this._pendingQueue.length) {
            const pendingItem = this._pendingQueue.pop();
            pendingItem.callback(new Error("Pool is going down"));
        };
        await Promise.all(
            this._clients.filter(clientIsIdle).map(
                async function handleIdleClient(cl) {
                    try {
                        const timeoutError = new Error(
                            "Timed out client released due to Pool shutdown"
                        );
                        if (clientIsTimedOut(cl)) {
                            cl.emit("error", timeoutError);
                            return await cl.release();
                        } else if (
                            !! cl.connectionParameters.client_timeout
                        ) {
                            const pendingMs = (
                                cl.ctime
                                + cl.connectionParameters.client_timeout
                                - Date.now()
                            );
                            return await new Promise(resolve => {
                                setTimeout(async ()=>{
                                    cl.emit(timeoutError);
                                    resolve (await cl.release());
                                }, pendingMs);
                            });
                        };
                    } catch (originalError) {
                        cl.emit("error", new Error(
                            "Cannot release timed out idle client"
                        ));
                        return cl;
                    };
                }
            )
        );
        return await super.end(...args);
    };//}}}

    async recover() {//{{{
        const targetClients = this._clients.filter(clientIsDefunct);
        if (! targetClients.length) return false; // Nothing to recover.
        while (targetClients.length) {
            const defunctClient = targetClients.pop();
            if (this.autoCancel) {
                // Annotate remote PID:
                this.defunctPIDs.push(defunctClient.processID);
            };
            try {
                await defunctClient.release();
            } catch (err) {};  // NOP in case already released.
            if ( // Not working
                this._clients.filter(clientIsDefunct) >= targetClients.length
            ) break;
        };
        return targetClients.length == 0; // Full success.
    };//}}}

    async isAlive () {//{{{
        return await new Promise((resolve) => {
            const host = this.options.host || "localhost";
            const port = this.options.port || 5432;
                // 👆 FIXME: These should go in sync with node-postgres
            const socket = new net.Socket();
            const timer = setTimeout(() => {
                ///console.log(" 🕒 Timeout!!!");
                if (! socket.destroyed) socket.destroy();
                resolve(false);
            }, PING_TIMEOUT);
            socket.on("error", (err)=>{
                ///console.log(" ❌ Error!!!", err?.message);
                resolve(false);
                socket.destroy();
            });
            socket.on("data", data => {
                ///console.log(" 📝 DATA!!!", data.toString());
                resolve (!! data.toString().match(PONG_PATTERN)); // Alive if matches
                socket.end();
            });
            socket.on("close", (err) => {
                ///console.log(" ✖️  Close!!!", err);
                resolve("false");
                    // Just in case its closed due to non expected reason.
                clearTimeout(timer);
            });
            socket.on("connect", (...args)=> {
                ///console.log(" 🔥 Connect!!!", args)
                socket.write(PING_MESSAGE);
            });
            socket.connect(port, host);
        });
    };//}}}

    watchForConnection(err = false) {//{{{
        if (this.connectionWatcher) return; // Allow single watcher at any time
        let reportConnection = ! err;
        let reportDisconnection = true;
        const connectionCheck = async () => {
            if (! await this.isAlive()) {
                this.connectionError = true;
                if (reportDisconnection) {
                    this.emit("error", new Error("Server host not reachable"));
                    reportDisconnection = false; // Report only once.
                    reportConnection = true;
                };
            } else {
                this.connectionError = false;
                if (reportConnection) this.emit("ready", {
                    message: "Server host is reachable.",
                    // FIXME: Add more data to propperly identify the pool.
                });
                clearInterval(this.connectionWatcher);
                this.connectionWatcher = null;
                if (this.autoCancel && this.defunctPIDs.length) {
                    // Give opportunity for disconnected clients cancellation:
                    this.connect().then(c=>c.release());
                };
            };
        };
        this.connectionWatcher = setInterval(
            connectionCheck
            , this.reconnectInterval
        );
        // Check immediately on startup:
        if (reportConnection) connectionCheck();
    };//}}}

};

module.exports = {
    Pool,
};
