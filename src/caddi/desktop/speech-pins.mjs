// Reviewed local whisper.cpp assets. This file is shared by the development
// evaluator, the offline packager, and the packaged main-process loader.
export const SPEECH_MODEL_ID = 'whisper-cpp-1_9_5-tiny-en';
export const SPEECH_SOURCE_COMMIT = 'd1be6fde11ac6e0407606b4e42fe72d34add8037';
export const SPEECH_PROVENANCE = Object.freeze({
  whisperCppSource: 'https://github.com/ggml-org/whisper.cpp/tree/d1be6fde11ac6e0407606b4e42fe72d34add8037',
  modelCard: 'https://huggingface.co/ggerganov/whisper.cpp/blob/5359861c739e955e79d9a303bcbc70fb988958b1/README.md',
  whisperLicense: 'https://raw.githubusercontent.com/openai/whisper/main/LICENSE',
});
export const SPEECH_RESOURCE_DIRECTORY = 'caddi-speech';
export const SPEECH_PINS = Object.freeze([
  Object.freeze({ role: 'report', development: '.test-artifacts/caddi-speech/evaluation-o27f1wjf/report.json', maximum: 131_072, sha256: 'de5ae32d3d9baf02721b04b2d2c7cc26b11eb62eccb0df8cc4b1e6806b0cc99a' }),
  Object.freeze({ role: 'license', development: '.test-artifacts/caddi-speech/evaluation-o27f1wjf/source/LICENSE', bundled: 'ggml-LICENSE', maximum: 16_384, sha256: '94f29bbed6a22c35b992c5c6ebf0e7c92f13b836b90f36f461c9cf2f0f1d010d' }),
  Object.freeze({ role: 'program', development: '.test-artifacts/caddi-speech/evaluation-o27f1wjf/build/bin/whisper-cli', bundled: 'whisper-cli', bytes: 2_548_872, sha256: 'd82efdc16b0b4db07dc35a5f82394b7954b97d0851ab41bf51eaac1b103fc099' }),
  Object.freeze({ role: 'model', development: '.test-artifacts/caddi-speech/inputs-le991uqb/ggml-tiny.en.bin', bundled: 'ggml-tiny.en.bin', bytes: 77_704_715, sha256: '921e4cf8686fdd993dcd081a5da5b6c365bfde1162e72b08d75ac75289920b1f' }),
  Object.freeze({ role: 'whisper-license', bundled: 'WHISPER-LICENSE', maximum: 16_384, sha256: 'b5d65a59060e68c4ff940e1eddfa6f94b2d68fdf58ed7f4dd57721c997e35e9d' }),
  Object.freeze({ role: 'model-card', bundled: 'MODEL-CARD.md', maximum: 262_144, sha256: '21fd967098804f33fc84e803fb0e5ab7666d71801f4027cf28a65e7af09c1758' }),
]);
export const BUNDLED_SPEECH_PINS = Object.freeze(SPEECH_PINS.filter(pin => pin.bundled));
