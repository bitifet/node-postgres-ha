
const pg = require("pg");


class Pool extends pg.Pool {

    // Overload Client implementation
    constructor(...args) {//{{{
        super(...args);
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
    status() {//{{{
        const max = this.options.max;
        const used = this._clients.length;
        const free = max - used;
        const pending = this._pendingQueue.length;
        return {
            max,
            used,
            free,
            pending,
            clients: this._clients.map(
                this.constructor.clientStatus
            ),
        };
    };//}}}

    // Overload connect() method to:
    //   - Capture failed connection attempt errors.
    //   - Return a proxy preventing client access after releasing.
    async connect(...args) {
        try {
            const client = await super.connect(...args);
            let released = false;
            return new Proxy(client, {
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

        } catch (err) {
            // Emit failed connection attempt errors.
            this.emit("error", err, null);
            throw err;
        };
    };

    async end(...args) {
        while (this._pendingQueue.length) {
            const pendingItem = this._pendingQueue.pop();
            pendingItem.callback(new Error("Pool is going down"));
        };
        // Don't need this!!{{{
        ///console.log(this);
        // this._clients.map(c=>c.end((err)=>{
        //     console.log(
        //         err ? "❌ Connection closed with errors"
        //         : "✅ Connection successfully closed"
        //     );
        //
        // }));}}}
        super.end(...args);
    };

};

module.exports = {
    Pool,
};
