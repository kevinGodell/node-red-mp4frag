# @kevingodell/node-red-mp4frag
######
[![GitHub license](https://img.shields.io/badge/license-MIT-brightgreen.svg)](https://raw.githubusercontent.com/kevinGodell/node-red-mp4frag/master/LICENSE)
[![npm](https://img.shields.io/npm/dt/@kevingodell/node-red-mp4frag.svg?style=flat-square)](https://www.npmjs.com/package/@kevingodell/node-red-mp4frag)
[![GitHub issues](https://img.shields.io/github/issues/kevinGodell/node-red-mp4frag.svg)](https://github.com/kevinGodell/node-red-mp4frag/issues)

**A [Node-RED](https://nodered.org/) node used for parsing fragmented mp4 video from [ffmpeg](https://ffmpeg.org/).**

* designed to live stream mp4 video as HLS or socket.io to the ui_mp4frag node

### Expectations:
* You should have working knowledge of ffmpeg on the command line.
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
<img width="500" alt="help" src="https://user-images.githubusercontent.com/6091746/207752847-c675dbe2-6cbc-41a3-af25-2ad4774e21a0.png">

### Flows:
https://github.com/kevinGodell/node-red-mp4frag/tree/master/examples
