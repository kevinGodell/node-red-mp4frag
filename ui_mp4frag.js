'use strict';

module.exports = RED => {
  const { _ } = RED; // locale string getter

  const { createNode, getNode, registerType } = RED.nodes;

  const { addWidget } = RED.require('node-red-dashboard')(RED);

  const { uiMp4fragHlsJs = 'https://cdn.jsdelivr.net/npm/hls.js@latest/dist/hls.js' } = RED.settings;

  const NODE_TYPE = 'ui_mp4frag';

  class UiMp4FragNode {
    constructor(config) {
      createNode(this, config);

      // return early if ui_group does not exist
      if (UiMp4FragNode.uiGroupExists(config) === true) {
        config.videoID = `video_${this.type}_${this.id}`;

        UiMp4FragNode.addToBody(this, config); // adds the html markup to the body

        UiMp4FragNode.addToHead(); // adds the script to the head (only once)

        this._onInput = msg => void UiMp4FragNode.onInput(this, msg); // bind `this` using fat arrow, void to indicate no return val

        this.on('input', this._onInput); // listen to the input event

        this._onClose = (removed, done) => void UiMp4FragNode.onClose(this, removed, done);

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
      if (UiMp4FragNode.headDone === undefined && UiMp4FragNode.nodeCount++ === 0) {
        UiMp4FragNode.headDone = addWidget({
          node: '',
          group: '',
          order: 0,
          width: 0,
          height: 0,
          format: UiMp4FragNode.renderHead(),
          templateScope: 'global', // global causes `format` to be inserted in <head>
          emitOnlyNewValues: false,
          forwardInputMessages: false,
          storeFrontEndInputAsState: false,
        });
      }
    }

    static removeFromHead() {
      if (typeof UiMp4FragNode.headDone === 'function' && --UiMp4FragNode.nodeCount === 0) {
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
        format: UiMp4FragNode.renderBody(config),
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
          $scope.hasHlsJs = function () {
            return typeof Hls === 'function' && Hls.isSupported() === true;
          };

          $scope.hasHlsNative = function () {
            return $scope.video.canPlayType('application/vnd.apple.mpegurl') !== '';
          };

          $scope.playVideo = async function () {
            try {
              await $scope.video.play();
              $scope.video.controls = true;
            } catch (err) {
              console.error(err);
              $scope.videoError();
            }
          };

          $scope.videoError = function () {
            console.log('error video id', $scope.video.id);
            $scope.video.controls = false;
            $scope.video.poster = $scope.config.errorPoster;
          };

          $scope.init = function (config) {
            $scope.config = config;

            $scope.video = document.getElementById(config.videoID);
          };

          // todo might name this .resetVideo()??
          $scope.destroyVideo = function () {
            // todo might just call pause() without checking video properties
            if ($scope.video.paused === false || $scope.video.ended === false) {
              $scope.video.pause();
            }

            if ($scope.hls) {
              $scope.hls.destroy();
            } else {
              $scope.video.src = '';
            }

            $scope.video.controls = false;

            $scope.video.poster = $scope.config.readyPoster;
          };

          $scope.createVideo = function () {
            // todo check config to see if we should use hls.js or native, either both in some order, or only 1
            if ($scope.hasHlsJs() === true) {
              console.log('trying Hls.js');

              $scope.hls = new Hls({
                liveDurationInfinity: true,
                liveBackBufferLength: 0,
                maxBufferLength: 5, // default 30
                manifestLoadingTimeOut: 1000,
                manifestLoadingMaxRetry: 10,
                manifestLoadingRetryDelay: 500,
              });

              $scope.hls.loadSource($scope.playlist);

              $scope.hls.attachMedia($scope.video);

              // todo check config.autoplay
              $scope.hls.on(Hls.Events.MANIFEST_PARSED, function () {
                console.log('manifest parsed');
                $scope.playVideo();
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
            } else if ($scope.hasHlsNative() === true) {
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
                $scope.videoError();
              };

              $scope.video.src = $scope.playlist;

              $scope.video.addEventListener('loadedmetadata', function () {
                console.log('loadedmetadata');
                $scope.playVideo();
              });
            } else {
              console.error('your browser does not support hls video playback');
              $scope.videoError();
            }
          };

          $scope.$watch('msg', function (msg) {
            if (!msg) {
              return;
            }

            // todo switch(msg.topic)...

            // resets video player
            $scope.destroyVideo();

            if (!msg.payload) {
              // todo should empty payload or a msg.topic = stop|destroy tell us to quit ??
              console.log('empty payload causes the process to NOT start a new video');
              return;
            }

            // simple check to see if playlist should be valid
            if (msg.payload.endsWith('.m3u8') === false) {
              console.error(`bad playlist ${msg.payload}`);
              $scope.videoError();
              return;
            }

            // save playlist in case we can't use it immediately due to Hls.js race condition
            $scope.playlist = msg.payload;

            // debugger;
            // running debugger or console.log() gives Hls a chance to be ready

            /*
              todo: fix this hack
              - handle Hls race condition if lib not already cached in browser
              - Hls will be undefined when playlist msg arrives
              - condition can be easily illustrated when using private browsing mode
              in firefox and loading ui video player for first time
            */
            if (typeof Hls === 'undefined') {
              if (typeof $scope.timeout !== 'undefined') {
                clearTimeout($scope.timeout);
              }

              $scope.timeout = setTimeout(() => {
                $scope.timeout = undefined;
                $scope.createVideo();
              }, 2000);
              console.warn('received playlist before Hls.js loaded, trying again in 2 seconds');
              return;
            }

            // if we made it here, Hls must be available, safe to create video
            $scope.createVideo();
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

    static renderHead() {
      return String.raw`<script type="text/javascript" src="${uiMp4fragHlsJs}"></script>`;
      // return String.raw`<script>const scriptElem = document.createElement('script');scriptElem.type = 'text/javascript';scriptElem.src = '${uiMp4fragHlsJs}';scriptElem.async = false;scriptElem.defer = false;const headElem = document.getElementsByTagName('head')[0];headElem.parentNode.appendChild(scriptElem);</script>`;
    }

    static renderBody(config) {
      const style = 'width:100%;height:100%;overflow:hidden;border:1px solid black;';
      // todo muted playsinline poster will all be checkbox options, maybe as a single `options` value
      return String.raw`<div style="${style}" ng-init='init(${JSON.stringify(config)})'>
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
