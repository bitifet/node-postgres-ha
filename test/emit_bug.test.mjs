import assert from "assert";
import { Pool } from "../node_postgres_ha.js";

describe("Testing TypeError: this.emit is not a function bug", function() {
    
    it("should handle query errors through parentPool.emit instead of this.emit", function(done) {
        // Create a pool 
        const pool = new Pool({
            max: 1,
            allowExitOnIdle: true,
        });

        // Track errors emitted to pool - this is where the fix should route errors
        let allErrorsReceived = [];
        pool.on("allErrors", (err, client) => {
            allErrorsReceived.push({ err, client });
            console.log("allErrors received:", err.message);
        });
        
        // Create a client instance using the pool's Client class
        const ClientClass = pool.Client;
        const testClient = new ClientClass({});
        
        // Simulate the scenario from the bug report: query fails and tries to emit error
        const originalQuery = Object.getPrototypeOf(Object.getPrototypeOf(testClient)).query;
        Object.getPrototypeOf(Object.getPrototypeOf(testClient)).query = function() {
            throw new Error("Simulated query failure for testing");
        };
        
        // Call query - this should trigger the error handling code that was buggy
        testClient.query("SELECT 1").then(() => {
            done(new Error("Expected query to throw error"));
        }).catch((err) => {
            // Restore original method
            Object.getPrototypeOf(Object.getPrototypeOf(testClient)).query = originalQuery;
            
            // Check that the error was our expected error, not a TypeError
            if (err.message.includes("this.emit is not a function")) {
                done(new Error("Fix failed: still getting emit TypeError"));
            } else if (err.message === "Simulated query failure for testing") {
                // Good! The error was properly handled
                // Check that the error was also emitted to parentPool
                setTimeout(() => {
                    if (allErrorsReceived.length > 0) {
                        console.log("✅ Error correctly routed to parentPool");
                        pool.end().then(() => done()).catch(done);
                    } else {
                        done(new Error("Error was not emitted to parentPool as expected"));
                    }
                }, 10);
            } else {
                done(new Error("Unexpected error: " + err.message));
            }
        });
    });

    it("should not throw TypeError when query encounters error", function(done) {
        // Create a pool and test that query errors don't cause TypeError
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