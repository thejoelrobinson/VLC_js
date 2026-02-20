const spinnerElement = document.getElementById('spinner');
const overlayElement = document.getElementById('canvas');
const spinnerLdsElement = document.getElementById('spinner-lds');

const body = document.getElementById('body');
const isLoading = new CustomEvent('isLoading', { detail: { loading: true } });
const isNotLoading = new CustomEvent('isLoading', { detail: { loading: false } });

const VlcModuleExt = {
  preRun: [ function() {
    window.display_overlay = true
  }],
  vlc_access_file: {},
  onRuntimeInitialized: function() {},
  print: (() => {
    const element = document.getElementById('output');
    if (element) element.value = '';
    return (...args) => {
      const text = args.join(' ');
      console.log(text);
      if (element) {
        element.value += text + "\n";
        element.scrollTop = element.scrollHeight;
      }
    };
  })(),
  printErr: (...args) => {
    const text = args.join(' ');
    console.error(text);
  },

  canvas: (function() {
    var canvas = document.getElementById('canvas')
    // var overlay = document.getElementById('overlay')
    // As a default initial behavior, pop up an alert when webgl context is lost. To make your
    // application robust, you may want to override this behavior before shipping!
    // See http://www.khronos.org/registry/webgl/specs/latest/1.0/#5.15.2
    canvas.addEventListener("webglcontextlost", function(e) {
      console.error('WebGL context lost. You will need to reload the page.');
      e.preventDefault();
    });
    return canvas;
  })(),
  setStatus: function(text) {
    if (!VlcModuleExt.setStatus.last) VlcModuleExt.setStatus.last = { time: Date.now(), text: '' };
    if (text === VlcModuleExt.setStatus.last.text) return;
    var m = text.match(/([^(]+)\((\d+(\.\d+)?)\/(\d+)\)/);
    var now = Date.now();
    if (m && now - VlcModuleExt.setStatus.last.time < 30) return; // if this is a progress update, skip it if too soon
    VlcModuleExt.setStatus.last.time = now;
    VlcModuleExt.setStatus.last.text = text;
    if (m) {
      text = m[1];
      body.dispatchEvent(isLoading);
    } else {
      body.dispatchEvent(isNotLoading);
    }
  },
  totalDependencies: 0,
  monitorRunDependencies: function(left) {
    this.totalDependencies = Math.max(this.totalDependencies, left);
    VlcModuleExt.setStatus(left ? 'Preparing... (' + (this.totalDependencies-left) + '/' + this.totalDependencies + ')' : 'All downloads complete.');
  }
};
