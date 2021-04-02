# node-red-contrib-mp4frag
######
[![GitHub license](https://img.shields.io/badge/license-MIT-brightgreen.svg)](https://raw.githubusercontent.com/kevinGodell/node-red-contrib-mp4frag/master/LICENSE?token=ABOPHYQ73XPHMEGBSABCDJK7IKRQO)
[![npm](https://img.shields.io/npm/dt/node-red-contrib-mp4frag.svg?style=flat-square)](https://www.npmjs.com/package/node-red-contrib-mp4frag)
[![GitHub issues](https://img.shields.io/github/issues/kevinGodell/node-red-contrib-mp4frag.svg)](https://github.com/kevinGodell/node-red-contrib-mp4frag/issues)
#### What?
- A node-red fragmented mp4 server.
#### Why?
- Needed for extracting a fragmented mp4 from a buffer stream.
#### How?
- Parses the fragments (initialization and segments) of the mp4.
#### When?
- Using ffmpeg to connect to a video source and piping out a fragmented mp4.
#### Where?
- Fragmented mp4 files will be available on http server.
#### Requirements
- Input must be a buffer stream containing a properly fragmented mp4.
- ffmpeg flags: `-f mp4 -movflags +frag_keyframe+empty_moov+default_base_moof`.
#### Links
- [node-red](https://nodered.org/)
- [ffmpeg](https://ffmpeg.org/)
- [buffer](https://nodejs.org/api/buffer.html)
- [mp4frag](https://www.npmjs.com/package/mp4frag)
#### Installation
```
npm install kevinGodell/node-red-contrib-mp4frag
```
#### Flow Examples
- Using Built-in HTTP Routes:
##### Flow:
```json
[{"id":"2f41f30b.8ec0fc","type":"inject","z":"e2251434.ff28f8","name":"Start stream","props":[{"p":"payload"}],"repeat":"","crontab":"","once":false,"onceDelay":"1","topic":"","payload":"true","payloadType":"bool","x":110,"y":120,"wires":[["912efe6e.23585"]]},{"id":"912efe6e.23585","type":"switch","z":"e2251434.ff28f8","name":"","property":"payload","propertyType":"msg","rules":[{"t":"true"},{"t":"false"}],"checkall":"true","repair":false,"outputs":2,"x":261,"y":120,"wires":[["95995258.5666f"],["5b1456bf.ecdd98"]]},{"id":"95995258.5666f","type":"exec","z":"e2251434.ff28f8","command":"ffmpeg -re -i http://f24hls-i.akamaihd.net/hls/live/221147/F24_EN_HI_HLS/master_2000.m3u8 -c:v copy -c:a aac -f mp4 -movflags +frag_keyframe+empty_moov+default_base_moof pipe:1","addpay":false,"append":"","useSpawn":"true","timer":"","oldrc":false,"name":"france 24 news","x":480,"y":120,"wires":[["a5d849e1.2b3bb8"],[],["a5d849e1.2b3bb8"]]},{"id":"5b1456bf.ecdd98","type":"function","z":"e2251434.ff28f8","name":"stop","func":"msg = {\n kill:'SIGHUP',\n payload : 'SIGHUP' \n}\n\nreturn msg;","outputs":1,"noerr":0,"initialize":"","finalize":"","x":281,"y":169,"wires":[["95995258.5666f"]]},{"id":"ea4bf81.4513b08","type":"inject","z":"e2251434.ff28f8","name":"Stop stream","props":[{"p":"payload"}],"repeat":"","crontab":"","once":false,"onceDelay":0.1,"topic":"","payload":"false","payloadType":"bool","x":110,"y":166,"wires":[["912efe6e.23585"]]},{"id":"a5d849e1.2b3bb8","type":"mp4frag","z":"e2251434.ff28f8","name":"","migrate":1e-9,"hlsPlaylistSize":"20","hlsPlaylistExtra":"10","basePath":"fr24_1","processVideo":true,"commandPath":"ffmpeg","commandArgs":"[\"-loglevel\",\"quiet\",\"-f\",\"mp4\",\"-i\",\"pipe:0\",\"-f\",\"mp4\",\"-c\",\"copy\",\"-movflags\",\"+faststart+empty_moov\",\"-t\",\"60\",\"-fs\",\"8000000\",\"pipe:1\"]","x":730,"y":140,"wires":[[],[]]}]
```
- Triggering mp4 video output for recording:
##### Flow:
```json
[{"id":"9215bc1c.b408d","type":"inject","z":"28dd399e.972736","name":"Start stream","props":[{"p":"payload"}],"repeat":"","crontab":"","once":false,"onceDelay":"1","topic":"","payload":"true","payloadType":"bool","x":110,"y":100,"wires":[["f001af15.29445"]]},{"id":"f001af15.29445","type":"switch","z":"28dd399e.972736","name":"","property":"payload","propertyType":"msg","rules":[{"t":"true"},{"t":"false"}],"checkall":"true","repair":false,"outputs":2,"x":261,"y":100,"wires":[["40073444.e625bc"],["a1330022.ca53c"]]},{"id":"40073444.e625bc","type":"exec","z":"28dd399e.972736","command":"ffmpeg -re -i http://f24hls-i.akamaihd.net/hls/live/221147/F24_EN_HI_HLS/master_2000.m3u8 -c:v copy -c:a aac -f mp4 -movflags +frag_keyframe+empty_moov+default_base_moof pipe:1","addpay":false,"append":"","useSpawn":"true","timer":"","oldrc":false,"name":"france 24 news","x":480,"y":100,"wires":[["1d68b87a.0fefc8"],[],["1d68b87a.0fefc8"]]},{"id":"a1330022.ca53c","type":"function","z":"28dd399e.972736","name":"stop","func":"msg = {\n kill:'SIGHUP',\n payload : 'SIGHUP' \n}\n\nreturn msg;","outputs":1,"noerr":0,"initialize":"","finalize":"","x":281,"y":149,"wires":[["40073444.e625bc"]]},{"id":"80cd04c4.71b318","type":"inject","z":"28dd399e.972736","name":"Stop stream","props":[{"p":"payload"}],"repeat":"","crontab":"","once":false,"onceDelay":0.1,"topic":"","payload":"false","payloadType":"bool","x":110,"y":146,"wires":[["f001af15.29445"]]},{"id":"1d68b87a.0fefc8","type":"mp4frag","z":"28dd399e.972736","name":"","migrate":1e-9,"hlsPlaylistSize":"20","hlsPlaylistExtra":"10","basePath":"fr24_2","processVideo":true,"commandPath":"ffmpeg","commandArgs":"[\"-loglevel\",\"quiet\",\"-f\",\"mp4\",\"-i\",\"pipe:0\",\"-f\",\"mp4\",\"-c\",\"copy\",\"-movflags\",\"+faststart+empty_moov\",\"-t\",\"60\",\"-fs\",\"8000000\",\"pipe:1\"]","x":730,"y":120,"wires":[[],["ea3f12ef.4b81f"]]},{"id":"ea3f12ef.4b81f","type":"file","z":"28dd399e.972736","name":"","filename":"","appendNewline":false,"createDir":false,"overwriteFile":"false","encoding":"none","x":810,"y":260,"wires":[[]]},{"id":"d602be42.d4dbc","type":"inject","z":"28dd399e.972736","name":"write start -1, 5000, 2500000","props":[{"p":"action","v":"{\"subject\":\"write\",\"command\":\"start\",\"keyframe\":-1,\"timeLimit\":5000,\"sizeLimit\":2500000}","vt":"json"}],"repeat":"","crontab":"","once":false,"onceDelay":0.1,"topic":"","payloadType":"str","x":460,"y":200,"wires":[["1d68b87a.0fefc8"]]},{"id":"a1640b3b.120f68","type":"inject","z":"28dd399e.972736","name":"write start -5, 5000, 2500000","props":[{"p":"action","v":"{\"subject\":\"write\",\"command\":\"start\",\"keyframe\":-5,\"timeLimit\":5000,\"sizeLimit\":2500000}","vt":"json"}],"repeat":"","crontab":"","once":false,"onceDelay":0.1,"topic":"","x":480,"y":240,"wires":[["1d68b87a.0fefc8"]]},{"id":"a965e1bc.5d78d","type":"inject","z":"28dd399e.972736","name":"write start with defaults","props":[{"p":"action","v":"{\"subject\":\"write\",\"command\":\"start\"}","vt":"json"}],"repeat":"","crontab":"","once":false,"onceDelay":0.1,"topic":"","x":520,"y":280,"wires":[["1d68b87a.0fefc8"]]},{"id":"b7066f7e.57fd3","type":"inject","z":"28dd399e.972736","name":"write stop","props":[{"p":"action","v":"{\"subject\":\"write\",\"command\":\"stop\"}","vt":"json"}],"repeat":"","crontab":"","once":false,"onceDelay":0.1,"topic":"","payloadType":"str","x":580,"y":320,"wires":[["1d68b87a.0fefc8"]]}]
```

#### Screenshots
![mp4frag flow_1](https://raw.githubusercontent.com/kevinGodell/node-red-contrib-mp4frag/recorder/screenshots/mp4frag_flow_1.png)

---

![mp4frag flow_2](https://raw.githubusercontent.com/kevinGodell/node-red-contrib-mp4frag/recorder/screenshots/mp4frag_flow_2.png)

---

![mp4frag flow_3](https://raw.githubusercontent.com/kevinGodell/node-red-contrib-mp4frag/recorder/screenshots/mp4frag_flow_3.png)

---

![mp4frag settings_1](https://raw.githubusercontent.com/kevinGodell/node-red-contrib-mp4frag/recorder/screenshots/mp4frag_settings_1.png)
