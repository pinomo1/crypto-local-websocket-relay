import { Server } from "socket.io";
import { createServer } from "http";
import { networkInterfaces } from "node:os";
import dgram from "node:dgram";
import { Hasher } from "./crypto/hasher";

const multicastAddress = "224.0.2.62";
const multicastSocket: dgram.Socket = dgram.createSocket({type: "udp4", reuseAddr: true});
const localAddresses: string[] = [];

const nets = networkInterfaces();

class ChatRoom{
    private name: string;
    private password: number;
    private sockets: Set<string>;

    constructor(name: string, password: string){
        this.name = name;
        this.password = Hasher.hash(password)
        this.sockets = new Set<string>();
    }

    getName(): string{
        return this.name;
    }

    checkPassword(password: string): boolean{
        return this.password == Hasher.hash(password);
    }

    addSocket(socket: string){
        this.sockets.add(socket);
    }

    removeSocket(socket: string){
        this.sockets.delete(socket);
    }

    getSockets(): Set<string>{
        return this.sockets;
    }
}

const ChatRooms = new Map<string, ChatRoom>();
const tokens = new Map<number, string>();
const sockets = new Map<string, string>();

for (const name of Object.keys(nets)) {
    for (const net of nets[name]!) {
        if (net.family === 'IPv4') {
            localAddresses.push(name + " - " + net.address);
        }
    }
}

multicastSocket.on('message', (msg, rinfo) => {
    let message = msg.toString();
    let address = rinfo.address;
    let port = rinfo.port;
    console.log(`Received ${message} from ${address}:${port}`);
    if (message == "DISCOVER"){
        let reply = Buffer.from("OFFER");
        multicastSocket.send(reply, port, address);
    }
});

const httpServer = createServer(function(req,res){
    let headers = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST',
        'Access-Control-Allow-Headers': 'Origin, X-Requested-With, Content-Type, Accept',
        'Content-Type': 'application/json'
    };
    
    if (req.method == "OPTIONS"){
        res.writeHead(200, headers);
        res.end(JSON.stringify({}));
    }

    else if (req.method == "POST"){
        let body = "";

        req.on('data', (chunk) => {
            body += chunk.toString();
        });

        req.on('end', () => {
            let json : any;
            try{
                json = JSON.parse(body);
            }
            catch(e){
                res.writeHead(400, headers);
                res.end(JSON.stringify({error: "Invalid JSON"}));
                return;
            }
            if (req.url == "/api/canaccess"){
                res.writeHead(200, headers);
                res.end();
            }

            else if (req.url == "/api/new"){
                let roomName : string, roomPassword : string;
                if (json.name == undefined || json.password == undefined){
                    res.writeHead(400, headers);
                    res.end(JSON.stringify({error: "Invalid JSON"}));
                    return;
                }
                roomName = json.name;
                roomPassword = json.password;
                if (roomName.length > 32 || roomPassword.length > 128 || roomName.length < 6 || roomPassword.length < 6){
                    res.writeHead(400, headers);
                    res.end(JSON.stringify({error: "Room name must be between 6 and 32 characters and password must be between 6 and 128 characters"}));
                    return;
                }
                if (ChatRooms.has(roomName)){
                    res.writeHead(400, headers);
                    res.end(JSON.stringify({error: "Room already exists"}));
                    return;
                }
                ChatRooms.set(roomName, new ChatRoom(roomName, roomPassword));
                const token = Hasher.hash(roomName + roomPassword);
                tokens.set(token, roomName);
                res.writeHead(200, headers);
                res.end(JSON.stringify({token: token}));
            }

            else if (req.url == "/api/join"){
                let roomName : string, roomPassword : string;
                if (json.name == undefined || json.password == undefined){
                    res.writeHead(400, headers);
                    res.end(JSON.stringify({error: "Invalid JSON"}));
                    return;
                }
                roomName = json.name;
                roomPassword = json.password;
                if (!ChatRooms.has(roomName)){
                    res.writeHead(400, headers);
                    res.end(JSON.stringify({error: "Room does not exist"}));
                    return;
                }
                if (!ChatRooms.get(roomName)!.checkPassword(roomPassword)){
                    res.writeHead(400, headers);
                    res.end(JSON.stringify({error: "Invalid password"}));
                    return;
                }
                const token = Hasher.hash(roomName + roomPassword);
                res.writeHead(200, headers);
                res.end(JSON.stringify({token: token}));
            }

            else{
                res.writeHead(404, headers);
                res.end(JSON.stringify({error: "Not found"}));
            }
        });
    }
    else{
        res.writeHead(404, headers);
        res.end(JSON.stringify({error: "Not found"}));
    }
});

const io = new Server(httpServer)
const port = 8002;

function isValidMessage(message: string): boolean{
    if (message.length > 65535){
        return false;
    }
    if (message.length == 0){
        return false;
    }
    return true;
}

function normalizeMessage(message: string): string{
    message = message.replace(/[\u2800-\u28FF]/g, '');
    message = message.replace(/\n\s+/g, '\n');
    message = message.replace(/\s+\n/g, '\n');
    message = message.replace(/\n+/g, '\n');
    message = message.trim();
    return message;
}

function logInterface(){
    console.log("Available interfaces:");
    for (let i = 0; i < localAddresses.length; i++){
        console.log(localAddresses[i] + ":" + port);
    }
    console.log("Multicast address: " + multicastAddress);
}

logInterface();

io.on('connection', (socket) => {
    socket.on('join', (sToken: string) => {
        let token: number = parseInt(sToken);
        if (!tokens.has(token)){
            socket.emit('error', "Invalid token");
            return;
        }
        let room = tokens.get(token);
        if (room == undefined){
            socket.emit('error', "Invalid token");
            return;
        }
        if (!ChatRooms.has(room)){
            socket.emit('error', "Room does not exist");
            return;
        }
        let chatRoom = ChatRooms.get(room)!;
        if (chatRoom.getSockets().size == 2){
            socket.emit('error', "Room is full");
            return;
        }
        chatRoom.addSocket(socket.id);
        sockets.set(socket.id, room);
        console.log(`[${room}] ${socket.id} joined`);
        socket.join(room);
        socket.to(room).emit('joined', room);
    });

    socket.on('chat', (message: string) => {
        if (!sockets.has(socket.id)){
            socket.emit('error', "Not logged in");
            return;
        }
        let room = sockets.get(socket.id)!;
        /*
        if (!isValidMessage(message)){
            socket.emit('error', "Invalid message");
            return;
        }
        */
        message = normalizeMessage(message);
        socket.to(room).emit('chat', message);
        console.log(`[${room}] ${socket.id}: ${message}`);
    });

    socket.on('service', (type: string, message: string) => {
        if (!sockets.has(socket.id)){
            socket.emit('error', "Not logged in");
            return;
        }
        let room = sockets.get(socket.id)!;
        socket.to(room).emit('service', type, message);
        console.log(`<Service> [${room}] ${socket.id}: ${type} ${message}`);
    });

    socket.on('disconnect', () => {
        if (!sockets.has(socket.id)){
            return;
        }
        let room = sockets.get(socket.id)!;
        let chatRoom = ChatRooms.get(room)!;
        chatRoom.removeSocket(socket.id);
        sockets.delete(socket.id);
        socket.to(room).emit('left', room);
        if (chatRoom.getSockets().size == 0){
            ChatRooms.delete(room);
        }
        console.log(`[${room}] ${socket.id} left`);
    });
});

httpServer.listen(port, () => {
    console.log(`listening on *:${port}`);
});

multicastSocket.addMembership(multicastAddress);
