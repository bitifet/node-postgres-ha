
const net = require("net");


const pingMessage = Buffer.from([
    0x00, 0x00, 0x00, 0x08, // Packet length
    0x00, 0x00, 0x00, 0x00  // Non existent Postgres version
]);
const expectedAnswer = "SFATAL";




const serverIsReachable = (host, port, timeout=1000) => new Promise((resolve) => {
    const socket = new net.Socket();
    const timer = setTimeout(() => {
        ///console.log(" 🕒 Timeout!!!");
        if (! socket.destroyed) socket.destroy();
        resolve(false);
    }, timeout);
    socket.on("error", (err)=>{
        ///console.log(" ❌ Error!!!", err?.message);
        resolve(false);
        socket.destroy();
    });
    socket.on("data", data => {
        ///console.log(" 📝 DATA!!!", data.toString());
        resolve (!! data.toString().match(expectedAnswer)); // Alive if matches
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
        socket.write(pingMessage);
    });
    socket.connect(port, host);
});


const clientIsDefunct = cl=>!!cl._ended;



module.exports = {
    serverIsReachable,
    clientIsDefunct,
};
