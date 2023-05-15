# @kevingodell/node-red-mp4frag

######
[![Buy me a coffee](https://img.shields.io/badge/-buy%20me%20a%20coffee-red?logo=buy%20me%20a%20coffee&style=flat-square)](https://buymeacoffee.com/kevinGodell)
[![GitHub license](https://img.shields.io/badge/license-MIT-brightgreen.svg?style=flat-square)](https://raw.githubusercontent.com/kevinGodell/node-red-mp4frag/master/LICENSE)
[![npm](https://img.shields.io/npm/dt/@kevingodell/node-red-mp4frag.svg?style=flat-square)](https://www.npmjs.com/package/@kevingodell/node-red-mp4frag)
[![GitHub issues](https://img.shields.io/github/issues/kevinGodell/node-red-mp4frag.svg?style=flat-square)](https://github.com/kevinGodell/node-red-mp4frag/issues)

**A [Node-RED](https://nodered.org/) node used for parsing fragmented mp4 video from [ffmpeg](https://ffmpeg.org/).**

* designed to live stream mp4 video via http or socket.io
* video can be viewed in modern browsers using [HLS.js](https://github.com/video-dev/hls.js/)
* video can be viewed in Safari browser using [native HLS](https://developer.apple.com/documentation/http_live_streaming)
* compatible with [@kevingodell/node-red-ui-mp4frag](https://github.com/kevinGodell/node-red-ui-mp4frag)

### Expectations:
* You should have working knowledge of ffmpeg on the command line.
* Input MP4 video should be properly fragmented so that it is compatible.
* When using ffmpeg, set `-movflags +frag_keyframe+empty_moov+default_base_moof`.
* If you have difficulties making it work, please open a new [discussion](https://discourse.nodered.org/) and tag me `@kevinGodell`.
* Do not send private messages asking for help because that will not benefit others with similar issues.

### Installation:
* go to the correct directory, usually ~/.node-red
```
cd ~/.node-red
```
* using npm
```
npm install @kevingodell/node-red-mp4frag
```
* reboot the node-red server
```
node-red-stop && node-red-start
```

### Instructions:
* See the detailed help text in the sidebar.

### Screenshots:
<img width="500" alt="flow" src="https://user-images.githubusercontent.com/6091746/207752665-9fc6b534-533a-4a5e-884f-71ec4581fa0b.png">
<img width="500" alt="properties" src="https://user-images.githubusercontent.com/6091746/207752801-95d4e014-3e8c-4e10-b318-51534c4f2ea1.png">
<img width="500" alt="help" src="https://user-images.githubusercontent.com/6091746/207995843-0b371b83-fbf3-4a42-bef0-e019ddf14b99.png">

### Flows:
https://github.com/kevinGodell/node-red-mp4frag/tree/master/examples
