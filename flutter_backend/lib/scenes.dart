import 'package:flutter/widgets.dart';

/// Decides the picture from frame and props. Frames with the same key are drawn only once, as the same picture. null draws nothing.
///
/// A Dart file on the project side exposes `final Map<String, KasaneruScene> scenes = {...};`.
abstract class KasaneruScene {
  String? key(int frame, Map<String, dynamic> props);
  Widget build(int frame, Map<String, dynamic> props);
}
