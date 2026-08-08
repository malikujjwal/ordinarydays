// `babel-preset-expo` carries everything this app needs, including Expo Router's transform
// and the Reanimated plugin ordering that Phase 2 will depend on. There is deliberately
// nothing else here: a hand-added plugin is the usual way a Metro build starts behaving
// differently from a web export.
module.exports = (api) => {
  api.cache(true);
  return { presets: ['babel-preset-expo'] };
};
