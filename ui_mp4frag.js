'use strict';

module.exports = RED => {
  const { _ } = RED; // locale string getter

  const { createNode, getNode, registerType } = RED.nodes;

  const { addWidget } = RED.require('node-red-dashboard')(RED);

  const { uiMp4fragHlsJs = 'https://cdn.jsdelivr.net/npm/hls.js@latest/dist/hls.min.js' } = RED.settings;

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
        convertBack: value => {
          // console.log('convert back', {value});
          return value;
        },
        beforeEmit: (msg, value) => {
          // console.log('before emit', {msg}, {value});
          return { msg };
        },
        beforeSend: (msg, orig) => {
          // console.log('before send', {msg}, {orig});
          if (orig) {
            return orig.msg;
          }
        },
        initController: ($scope, events) => {
          const hasHlsJs = () => {
            return typeof Hls === 'function' && Hls.isSupported() === true;
          };

          const hasHlsNative = () => {
            return $scope.video.canPlayType('application/vnd.apple.mpegurl') !== '';
          };

          const destroyVideo = errored => {
            $scope.video.pause();

            if (typeof $scope.hls === 'object' && typeof $scope.hls.destroy === 'function') {
              $scope.hls.destroy();
            } else {
              $scope.video.removeAttribute('src');

              $scope.video.load();

              $scope.video.onerror = undefined;
            }

            $scope.video.controls = false;

            $scope.video.poster = errored === true ? $scope.config.errorPoster : $scope.config.readyPoster;
          };

          const videoError = err => {
            console.error(`Error: id = ${$scope.video.id} details = ${err}`);

            destroyVideo(true);
          };

          const playVideo = async () => {
            try {
              await $scope.video.play();

              $scope.video.controls = true;
            } catch (err) {
              videoError(err);
            }
          };

          const createVideo = () => {
            if (hasHlsJs() === true) {
              console.log(`Log: id = ${$scope.video.id} details = trying Hls.js`);

              $scope.hls = new Hls({
                liveDurationInfinity: true,
                liveBackBufferLength: 0,
                maxBufferLength: 5, // default 30
                manifestLoadingTimeOut: 1000,
                manifestLoadingMaxRetry: 10,
                manifestLoadingRetryDelay: 500,
              });

              $scope.hls.loadSource($scope.msg.payload);

              $scope.hls.attachMedia($scope.video);

              // todo check config.autoplay
              $scope.hls.on(Hls.Events.MANIFEST_PARSED, () => {
                // console.log('manifest parsed');
                playVideo();
              });

              $scope.hls.on(Hls.Events.ERROR, (event, data) => {
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
                      // console.log('cannot recover, calling hls.destroy()');
                      videoError(data);
                      break;
                  }
                }
              });
            } else if (hasHlsNative() === true) {
              console.log(`Log: id = ${$scope.video.id} details = trying Hls native`);

              $scope.video.onerror = () => {
                videoError($scope.video.error);
              };

              $scope.video.src = $scope.msg.payload;

              $scope.video.addEventListener('loadedmetadata', () => {
                // console.log('loadedmetadata');

                playVideo();
              });
            } else {
              videoError('Hls.js and Hls native video not supported');
            }
          };

          // function called by ng-init='init(${JSON.stringify(config)})'
          $scope.init = config => {
            $scope.config = config;

            $scope.video = document.getElementById(config.videoID);
          };

          // watch for changes to $scope.msg, used to relay info from backend
          $scope.$watch('msg', (newVal, oldVal) => {
            // console.log(typeof newVal, typeof oldVal);

            if (typeof newVal === 'undefined') {
              return;
            }

            // todo switch(msg.topic)...

            // resets video player
            destroyVideo();

            if (newVal.payload.endsWith('.m3u8') === false) {
              console.warn(
                `Warn: id = ${$scope.video.id} details = video stopped due to payload: '${$scope.msg.payload}'`
              );
              return;
            }

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
                createVideo();
              }, 2000);
              console.warn(`Warn: id = ${$scope.video.id} details = Hls.js is undefined, trying again in 2 seconds`);
              return;
            }

            // if we made it here, Hls.js must be available, safe to create video
            createVideo();
          });

          /* const destroy = $scope.$on('$destroy', function () {
            console.log('destroyed');
            //destroy();
          });*/
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
