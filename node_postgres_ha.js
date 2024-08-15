
const pg = require("pg");
const {serverIsReachable, clientIsDefunct} = require("./lib/helpers");


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
        this.isAlive = serverIsReachable.bind(null, this.options.host, this.options.port);
        this.connectionError = false;
        this.connectionWatcher = null;

        // Implement allErrors event:{{{
        // --------------------------
        const baseClient = this.Client;
        const parentPool = this;
        this.Client = class extendedClient extends baseClient {
            constructor(...args) {
                super(...args);
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
        };
    };//}}}

    // Add method to retrieve overall pool status:
    status(showClients = false) {//{{{
        const max = this.options.max;
        const used = this._clients.length;
        const free = max - used;
        const pending = this._pendingQueue.length;
        const defunct = this._clients.filter(clientIsDefunct).length;
        const alive = this._clients.length - defunct;
        return {
            max,
            used,
            free,
            alive,
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

    // Implement our own query method since paren's once rely in original
    // client implementation.
    async query(...args) {//{{{
        /// // It was too beautiful to be real:
        /// return super.query.apply(this, args);
        let retval, error;
        const client = await this.connect();
        retval = await client.query(...args);
        client.release();
            // One may think we need to capture errors over query execution to ensure release is done.
            // But this is automatically done in the error handler.
        return retval;
    };//}}}

    async end(...args) {//{{{
        while (this._pendingQueue.length) {
            const pendingItem = this._pendingQueue.pop();
            pendingItem.callback(new Error("Pool is going down"));
        };
        super.end(...args);
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

    watchForConnection(err = false) {//{{{
        if (this.connectionWatcher) return; // Allow single watcher at any time
        let reportConnection = ! err;
        let reportDisconnection = true;
        this.connectionWatcher = setInterval(
            async () => {
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
            }
            , this.reconnectInterval
        );
    };//}}}


};

module.exports = {
    Pool,
};
