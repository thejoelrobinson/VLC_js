// VideoDecoder deferred configure — injected via --pre-js at emcc link time.
// Runs on ALL threads (main + pthreads workers) before the Emscripten module factory.
//
// Problem: VLC's webcodec plugin calls VideoDecoder.configure({codec:'avc1'}) at
// decoder Open() time, before the MXF demuxer has populated codec dimensions or
// profile/level. Chrome rejects bare 'avc1' (no profile/level suffix).
//
// Solution: Intercept configure() calls for avc1 variants, defer until the first
// decode() call, then re-issue with 'avc3.7a0033' (High 4:2:2 Profile Level 5.1,
// Annex B — the correct string for Canon Cinema EOS MXF H.264).
if (typeof VideoDecoder !== "undefined") {
  const _origConf = VideoDecoder.prototype.configure;
  const _origDec  = VideoDecoder.prototype.decode;
  const AVC3_CODEC = "avc3.7a0033";
  let _pendingCfg = null;
  VideoDecoder.prototype.configure = function(cfg) {
    if (cfg && (cfg.codec === "avc1" || cfg.codec === "avc1.640028" || cfg.codec === "avc1.640033")) {
      _pendingCfg = cfg;
      return;
    }
    return _origConf.call(this, cfg);
  };
  VideoDecoder.prototype.decode = function(chunk) {
    const dec = this;
    if (_pendingCfg !== null) {
      if (this.state === "closed") { _pendingCfg = null; return; }
      const cfg = Object.assign({}, _pendingCfg, { codec: AVC3_CODEC });
      _pendingCfg = null;
      try { _origConf.call(dec, cfg); } catch(e) { return; }
    }
    if (this.state === "closed") return;
    return _origDec.call(this, chunk);
  };
}
