import 'package:flutter/widgets.dart';

/// frameとpropsから絵を決める。keyが同じコマは同じ絵として1回だけ描かれる。nullは何も描かない。
///
/// 作品側のDartファイルは `final Map<String, KasaneruScene> scenes = {...};` を公開する。
abstract class KasaneruScene {
  String? key(int frame, Map<String, dynamic> props);
  Widget build(int frame, Map<String, dynamic> props);
}
