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
[{"id":"7788bf8c.30de18","type":"inject","z":"26b5a4eb.db1d34","name":"Start stream","props":[{"p":"payload"}],"repeat":"","crontab":"","once":false,"onceDelay":"1","topic":"","payload":"true","payloadType":"bool","x":110,"y":1960,"wires":[["67333353.dec864"]]},{"id":"b6f65007.eedf98","type":"inject","z":"26b5a4eb.db1d34","name":"Stop stream","props":[{"p":"payload"}],"repeat":"","crontab":"","once":false,"onceDelay":0.1,"topic":"","payload":"false","payloadType":"bool","x":110,"y":2006,"wires":[["67333353.dec864"]]},{"id":"67333353.dec864","type":"switch","z":"26b5a4eb.db1d34","name":"","property":"payload","propertyType":"msg","rules":[{"t":"true"},{"t":"false"}],"checkall":"true","repair":false,"outputs":2,"x":261,"y":1960,"wires":[["1d607f7b.591ca1"],["bcbdff87.e72b68"]]},{"id":"bcbdff87.e72b68","type":"function","z":"26b5a4eb.db1d34","name":"stop","func":"msg = {\n    kill:'SIGHUP',\n    payload : 'SIGHUP'  \n}\n\nreturn msg;","outputs":1,"noerr":0,"initialize":"","finalize":"","x":281,"y":2009,"wires":[["1d607f7b.591ca1"]]},{"id":"1d607f7b.591ca1","type":"exec","z":"26b5a4eb.db1d34","command":"ffmpeg -re -i http://f24hls-i.akamaihd.net/hls/live/221147/F24_EN_HI_HLS/master_2000.m3u8 -c:v copy -c:a aac -f mp4 -movflags +frag_keyframe+empty_moov+default_base_moof pipe:1","addpay":false,"append":"","useSpawn":"true","timer":"","oldrc":false,"name":"france 24 news","x":480,"y":1960,"wires":[["255f8a9b.706b56"],[],["255f8a9b.706b56"]]},{"id":"255f8a9b.706b56","type":"mp4frag","z":"26b5a4eb.db1d34","name":"","hlsPlaylistSize":"10","hlsPlaylistExtra":"5","basePath":"france24","x":750,"y":1960,"wires":[["3738a915.0168c6","9b37d873.00d0f8"]]}]
```
##### Flow (expanded):
```json
[
    {
        "id": "7788bf8c.30de18",
        "type": "inject",
        "z": "26b5a4eb.db1d34",
        "name": "Start stream",
        "props": [
            {
                "p": "payload"
            }
        ],
        "repeat": "",
        "crontab": "",
        "once": false,
        "onceDelay": "1",
        "topic": "",
        "payload": "true",
        "payloadType": "bool",
        "x": 110,
        "y": 1960,
        "wires": [
            [
                "67333353.dec864"
            ]
        ]
    },
    {
        "id": "b6f65007.eedf98",
        "type": "inject",
        "z": "26b5a4eb.db1d34",
        "name": "Stop stream",
        "props": [
            {
                "p": "payload"
            }
        ],
        "repeat": "",
        "crontab": "",
        "once": false,
        "onceDelay": 0.1,
        "topic": "",
        "payload": "false",
        "payloadType": "bool",
        "x": 110,
        "y": 2006,
        "wires": [
            [
                "67333353.dec864"
            ]
        ]
    },
    {
        "id": "67333353.dec864",
        "type": "switch",
        "z": "26b5a4eb.db1d34",
        "name": "",
        "property": "payload",
        "propertyType": "msg",
        "rules": [
            {
                "t": "true"
            },
            {
                "t": "false"
            }
        ],
        "checkall": "true",
        "repair": false,
        "outputs": 2,
        "x": 261,
        "y": 1960,
        "wires": [
            [
                "1d607f7b.591ca1"
            ],
            [
                "bcbdff87.e72b68"
            ]
        ]
    },
    {
        "id": "bcbdff87.e72b68",
        "type": "function",
        "z": "26b5a4eb.db1d34",
        "name": "stop",
        "func": "msg = {\n    kill:'SIGHUP',\n    payload : 'SIGHUP'  \n}\n\nreturn msg;",
        "outputs": 1,
        "noerr": 0,
        "initialize": "",
        "finalize": "",
        "x": 281,
        "y": 2009,
        "wires": [
            [
                "1d607f7b.591ca1"
            ]
        ]
    },
    {
        "id": "1d607f7b.591ca1",
        "type": "exec",
        "z": "26b5a4eb.db1d34",
        "command": "ffmpeg -re -i http://f24hls-i.akamaihd.net/hls/live/221147/F24_EN_HI_HLS/master_2000.m3u8 -c:v copy -c:a aac -f mp4 -movflags +frag_keyframe+empty_moov+default_base_moof pipe:1",
        "addpay": false,
        "append": "",
        "useSpawn": "true",
        "timer": "",
        "oldrc": false,
        "name": "france 24 news",
        "x": 480,
        "y": 1960,
        "wires": [
            [
                "255f8a9b.706b56"
            ],
            [],
            [
                "255f8a9b.706b56"
            ]
        ]
    },
    {
        "id": "255f8a9b.706b56",
        "type": "mp4frag",
        "z": "26b5a4eb.db1d34",
        "name": "",
        "hlsPlaylistSize": "10",
        "hlsPlaylistExtra": "5",
        "basePath": "france24",
        "x": 750,
        "y": 1960,
        "wires": [
            [
                "3738a915.0168c6",
                "9b37d873.00d0f8"
            ]
        ]
    }
]
```
#### Screenshots
![mp4frag flow](https://raw.githubusercontent.com/kevinGodell/node-red-contrib-mp4frag/master/screenshots/mp4frag_flow.png)
![mp4frag settings](https://raw.githubusercontent.com/kevinGodell/node-red-contrib-mp4frag/master/screenshots/mp4frag_settings.png)
