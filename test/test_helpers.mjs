
import {Pool} from "../node_postgres_ha.js";


export const sleep = secs => new Promise(
    resolve => setTimeout(
        resolve
        , secs * 1000 // Delay in secs for consistency with pg_sleep()
    )
);

// Check for an (un)expected error:
export const E = pattern => err => {
    // Test for expected error:
    if (err.message.match(pattern)) return true;
    throw err; // Rethrow so we can see the actual error
};

// Wait for a promise to resovle:
export const waitFor = async (p, secs = .1)=>{
    let resolved = false;
    return await Promise.race([
        p.then(()=>true), // Don't catch (errors not expected here)
        sleep(secs).then(()=>false),
    ]);
};

// Simulate connection failure for given client(s):
export async function disconnect(...clients) {
    return await Promise.all(
        clients.map(cl=>cl.connection.stream.destroy())
    );
};


export async function isCancelled(pid) {
    const p = new Pool({allowExitOnIdle: true});
    const {rows: [{cancelled}]} = await p.query(
        "SELECT count(1) = 0 as cancelled FROM pg_stat_activity WHERE pid = $1"
        , [pid]
    );
    p.end();
    return cancelled;
};
