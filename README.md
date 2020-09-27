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
```json
{}
```
#### Screenshots
![screen shot 1](screenshot1.png)
