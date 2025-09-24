import assert from "assert";
import { Pool } from "../node_postgres_ha.js";

describe("Testing TypeError: this.emit is not a function bug", function() {
    
    it("should handle query errors by emitting to parent pool instead of client", async function() {
        // Create a pool 
        const pool = new Pool({
            max: 1,
            allowExitOnIdle: true,
        });

        // Track errors emitted to pool
        let allErrorsEmitted = [];
        pool.on("allErrors", (err, client) => {
            allErrorsEmitted.push({ err, client });
        });
        
        // Create a client instance using the pool's Client class
        const ClientClass = pool.Client;
        const testClient = new ClientClass({});
        
        // Test that the client has the right emit behavior
        // The client should NOT have an emit function that works like EventEmitter
        // Instead, errors should be emitted to parentPool
        assert(
            typeof testClient.emit !== 'function' || testClient.emit.toString().includes('parentPool'),
            "Client should either not have emit or should route to parentPool"
        );
        
        await pool.end();
    });

    it("should not throw TypeError when query encounters error", function(done) {
        // Create a pool and override internal behavior to test the fix
        const pool = new Pool({
            max: 1,
            allowExitOnIdle: true,
        });

        // Track allErrors events
        let errorEmitted = false;
        pool.on("allErrors", (err, client) => {
            errorEmitted = true;
            console.log("allErrors event received correctly:", err.message);
        });

        // Create a client and simulate the query error scenario
        const ClientClass = pool.Client;
        const client = new ClientClass({});
        
        // Simulate the scenario where super.query throws an error
        // and the client.query method needs to emit the error
        const originalQuery = Object.getPrototypeOf(Object.getPrototypeOf(client)).query;
        Object.getPrototypeOf(Object.getPrototypeOf(client)).query = function() {
            throw new Error("Test query error");
        };
        
        // Call the overridden query method
        client.query("SELECT 1").then(() => {
            done(new Error("Expected query to throw"));
        }).catch((err) => {
            // Restore original method
            Object.getPrototypeOf(Object.getPrototypeOf(client)).query = originalQuery;
            
            // Check that we got the right error and not a TypeError about emit
            if (err.message.includes("this.emit is not a function")) {
                done(new Error("Bug still exists: " + err.message));
            } else if (err.message === "Test query error") {
                // This means the error was properly handled
                console.log("Query error handled correctly");
                pool.end().then(() => done()).catch(done);
            } else {
                done(new Error("Unexpected error: " + err.message));
            }
        });
    });
});