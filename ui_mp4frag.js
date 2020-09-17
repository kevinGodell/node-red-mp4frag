'use strict';

module.exports = RED => {
  const { _ } = RED; // locale string getter

  const { createNode, getNode, registerType } = RED.nodes;

  const { addWidget } = RED.require('node-red-dashboard')(RED);

  const { uiMp4fragHlsJs = 'https://cdn.jsdelivr.net/npm/hls.js@latest/dist/hls.light.min.js' } = RED.settings;

  const NODE_TYPE = 'ui_mp4frag';

  class UiMp4FragNode {
    constructor(config) {
      createNode(this, config);

      // return early if ui_group does not exist
      if (UiMp4FragNode.uiGroupExists(config) === true) {
        config.videoID = `video_${this.type}_${this.id}`;

        UiMp4FragNode.addToBody(this, config); // adds the html markup to the body

        UiMp4FragNode.addToHead(); // adds the script to the head (only once)

        this._onInput = msg => UiMp4FragNode.onInput(this, msg); // bind `this` using fat arrow

        this.on('input', this._onInput); // listen to the input event

        this._onClose = (removed, done) => UiMp4FragNode.onClose(this, removed, done);

        this.on('close', this._onClose); // listen to the close event

        this.status({ fill: 'green', shape: 'ring', text: 'ready' });
      } else {
        this.error(_('ui_mp4frag.error.no-group'));

        this.status({ fill: 'red', shape: 'dot', text: 'ui_mp4frag.error.no-group' });
      }
    }

    static uiGroupExists(config) {
      const group = getNode(config && config.group);

      return !!(group && group.type === 'ui_group');
    }

    static addToHead() {
      if (UiMp4FragNode.nodeCount++ === 0 && UiMp4FragNode.headDone === undefined) {
        UiMp4FragNode.headDone = addWidget({
          node: '',
          group: '',
          order: 0,
          width: 0,
          height: 0,
          format: `<script src="${uiMp4fragHlsJs}"></script>`,
          templateScope: 'global', // global causes `format` to be inserted in <head>
          emitOnlyNewValues: false,
          forwardInputMessages: false,
          storeFrontEndInputAsState: false,
        });
      }
    }

    static removeFromHead() {
      if (--UiMp4FragNode.nodeCount === 0 && typeof UiMp4FragNode.headDone === 'function') {
        UiMp4FragNode.headDone();

        UiMp4FragNode.headDone = undefined;
      }
    }

    static addToBody(node, config) {
      node._bodyDone = addWidget({
        node: node,
        group: config.group,
        order: config.order || 0,
        width: config.width,
        height: config.height,
        format: UiMp4FragNode.renderHtml(config),
        templateScope: 'local', // local causes `format` to be inserted in <body>
        emitOnlyNewValues: false,
        forwardInputMessages: false, // true = we do not need to listen to on input event and manually forward msg
        storeFrontEndInputAsState: false,
        convertBack: function (value) {
          // console.log('convert back', {value});
          return value;
        },
        beforeEmit: function (msg, value) {
          // console.log('before emit', {msg}, {value});
          return { msg };
        },
        beforeSend: function (msg, orig) {
          // console.log('before send', {msg}, {orig});
          if (orig) {
            return orig.msg;
          }
        },
        initController: function ($scope, events) {
          async function playVideo() {
            $scope.video.poster = $scope.config.readyPoster;
            try {
              await $scope.video.play();
              console.log('hls video playing');
            } catch (err) {
              console.error(err);
              videoError();
            }
          }

          function videoError() {
            console.log('error video id', $scope.video.id);
            $scope.video.onmouseover = $scope.video.onmouseout = undefined;
            $scope.video.controls = false;
            $scope.video.poster = $scope.config.errorPoster;
          }

          $scope.init = function (config) {
            $scope.config = config;
            $scope.hlsJs = window.Hls && window.Hls.isSupported();
            $scope.video = document.getElementById(config.videoID);
            $scope.hlsNative = $scope.video.canPlayType('application/vnd.apple.mpegurl') !== ''; // probably|maybe|''

            // todo controls: mouseover, hidden, always, external(pass the video's id to some other ui component)
            $scope.video.onmouseover = function () {
              $scope.video.controls = true;
            };
            $scope.video.onmouseout = function () {
              $scope.video.controls = false;
            };
          };

          $scope.$watch('msg', function (msg) {
            if (!msg) {
              return;
            }

            if ($scope.video.paused === false || $scope.video.ended === false) {
              $scope.video.pause();
            }

            if ($scope.hls) {
              $scope.hls.destroy();
            }

            if (!msg.payload) {
              console.log('empty payload is trigger for video to not start after being stopped');
              return;
            }

            if (msg.payload.endsWith('.m3u8') === false) {
              videoError();
              return;
            }

            // todo check config to see if we should use hls.js or native, either both in some order, or only 1
            if ($scope.hlsJs) {
              console.log('trying hls js');

              $scope.hls = new Hls({
                liveDurationInfinity: true,
                liveBackBufferLength: 0,
                maxBufferLength: 5, // default 30
                manifestLoadingTimeOut: 1000,
                manifestLoadingMaxRetry: 10,
                manifestLoadingRetryDelay: 500,
              });

              $scope.hls.loadSource(msg.payload);

              $scope.hls.attachMedia($scope.video);

              $scope.hls.on(Hls.Events.MANIFEST_PARSED, async function () {
                console.log('manifest parsed');
                playVideo();
              });

              $scope.hls.on(Hls.Events.ERROR, function (event, data) {
                if (data.fatal) {
                  switch (data.type) {
                    case Hls.ErrorTypes.NETWORK_ERROR:
                      console.log('fatal network error encountered, try to recover');
                      $scope.hls.startLoad();
                      break;
                    case Hls.ErrorTypes.MEDIA_ERROR:
                      console.log('fatal media error encountered, try to recover');
                      $scope.hls.recoverMediaError();
                      break;
                    default:
                      console.log('cannot recover, calling hls.destroy()');
                      $scope.hls.destroy();
                      break;
                  }
                }
              });
            } else if ($scope.hlsNative) {
              console.log('trying hls native');

              $scope.video.onerror = function () {
                switch ($scope.video.error.code) {
                  case MediaError.MEDIA_ERR_ABORTED:
                    console.error('MediaError.MEDIA_ERR_ABORTED');
                    break;
                  case MediaError.MEDIA_ERR_DECODE:
                    console.error('MediaError.MEDIA_ERR_DECODE');
                    break;
                  case MediaError.MEDIA_ERR_NETWORK:
                    console.error('MediaError.MEDIA_ERR_NETWORK');
                    break;
                  case MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED:
                    console.error('MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED');
                    break;
                  case MediaError.MS_MEDIA_ERR_ENCRYPTED:
                    console.error('MediaError.MS_MEDIA_ERR_ENCRYPTED');
                    break;
                }
                videoError();
              };

              $scope.video.src = msg.payload;

              $scope.video.addEventListener('loadedmetadata', async function () {
                console.log('loadedmetadata');

                playVideo();
              });
            } else {
              console.error('your browser does not support hls video playback');
              videoError();
            }
          });
        },
      });
    }

    static removeFromBody(node) {
      if (typeof node._bodyDone === 'function') {
        node._bodyDone();

        node._bodyDone = undefined;
      }
    }

    static onInput(node, msg) {
      node.send(msg);
    }

    static onClose(node, removed, done) {
      node.removeListener('input', node._onInput);

      node._onInput = undefined;

      node.removeListener('close', node._onClose);

      node._onClose = undefined;

      UiMp4FragNode.removeFromHead();

      UiMp4FragNode.removeFromBody(node);

      if (removed) {
        node.status({ fill: 'red', shape: 'ring', text: 'removed' });
      } else {
        node.status({ fill: 'red', shape: 'dot', text: 'closed' });
      }

      if (typeof done === 'function') {
        done();
      }
    }

    static renderHtml(config) {
      const style = 'width:100%;height:100%;overflow:hidden;border:1px solid black;';
      // todo muted playsinline poster will all be checkbox options, maybe as a single `options` value
      return `<div style="${style}" ng-init='init(${JSON.stringify(config)})'>
        <video id="${config.videoID}" style="width:100%;height:100%;" muted playsinline poster="${config.readyPoster}">
          <p>Your browser does not support the HTML5 Video element.</p>
        </video>
      </div>`;
    }
  }

  UiMp4FragNode.nodeCount = 0; // increment in (successful) constructor, decrement on close event

  const UiMp4FragExtra = {
    settings: {
      uiMp4fragHlsJs: { value: uiMp4fragHlsJs, exportable: true },
    },
  };

  registerType(NODE_TYPE, UiMp4FragNode, UiMp4FragExtra);
};
