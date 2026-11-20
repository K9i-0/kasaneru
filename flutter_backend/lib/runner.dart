// The runner of the kasaneru Flutter rendering backend. Reads the job in the environment variable KASANERU_JOB and renders scenes to transparent PNGs.
// Scenes live in a Dart file on the project side; the generated entry point (test/generated/) loads it and passes it here.
import 'dart:convert';
import 'dart:io';
import 'dart:ui' as ui;

import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter/widgets.dart';
import 'package:flutter_test/flutter_test.dart';

import 'scenes.dart';

void runKasaneruJob(Map<String, KasaneruScene> scenes) {

  final job = jsonDecode(File(Platform.environment['KASANERU_JOB']!).readAsStringSync()) as Map<String, dynamic>;
  final fonts = (job['fonts'] as List).cast<Map<String, dynamic>>();

  setUpAll(() async {
    // By default flutter test draws every character as a box, so load the fonts in use explicitly.
    for (final font in fonts) {
      final bytes = File(font['file'] as String).readAsBytesSync();
      final loader = FontLoader(font['family'] as String)..addFont(Future.value(ByteData.sublistView(bytes)));
      await loader.load();
    }
  });

  testWidgets('kasaneru render', (tester) async {
    final width = (job['width'] as num).toDouble();
    final height = (job['height'] as num).toDouble();
    final frames = job['frames'] as int;
    final props = job['props'] as Map<String, dynamic>;
    final everyFrame = job['everyFrame'] as bool;
    final first = job['first'] as int;
    final last = job['last'] as int;
    final workDir = job['workDir'] as String;

    tester.view.physicalSize = Size(width, height);
    tester.view.devicePixelRatio = 1;
    debugDisableShadows = false;
    final boundaryKey = GlobalKey();
    final watch = Stopwatch()..start();

    Future<void> draw(Widget? child, String file, Map<String, dynamic>? region, Map<String, dynamic>? canvas) async {
      // A layer with canvas is drawn on a screen of that size (a horizontally long bar, for example).
      final cw = (canvas?['width'] as num?)?.toDouble() ?? width;
      final ch = (canvas?['height'] as num?)?.toDouble() ?? height;
      tester.view.physicalSize = Size(cw, ch);
      // A layer with region draws only that area, cropped out.
      final rx = (region?['x'] as num?)?.toDouble() ?? 0;
      final ry = (region?['y'] as num?)?.toDouble() ?? 0;
      final rw = (region?['width'] as num?)?.toDouble() ?? cw;
      final rh = (region?['height'] as num?)?.toDouble() ?? ch;
      await tester.pumpWidget(Directionality(
        textDirection: TextDirection.ltr,
        child: Align(
          alignment: Alignment.topLeft,
          child: RepaintBoundary(
            key: boundaryKey,
            child: SizedBox(
              width: rw,
              height: rh,
              child: ClipRect(
                child: OverflowBox(
                  alignment: Alignment.topLeft,
                  minWidth: cw, maxWidth: cw, minHeight: ch, maxHeight: ch,
                  child: Transform.translate(
                    offset: Offset(-rx, -ry),
                    child: DefaultTextStyle(
                      style: TextStyle(
                        fontFamily: fonts.isEmpty ? null : fonts.first['family'] as String,
                        fontWeight: FontWeight.w700,
                        fontSize: 16,
                        color: const Color(0xFFFFFFFF),
                      ),
                      child: child ?? const SizedBox.shrink(),
                    ),
                  ),
                ),
              ),
            ),
          ),
        ),
      ));
      final boundary = tester.renderObject<RenderRepaintBoundary>(find.byKey(boundaryKey));
      final png = await tester.runAsync(() async {
        final image = await boundary.toImage(pixelRatio: 1);
        final data = await image.toByteData(format: ui.ImageByteFormat.png);
        image.dispose();
        return data!;
      });
      File(file).writeAsBytesSync(png!.buffer.asUint8List(png.offsetInBytes, png.lengthInBytes));
    }

    final result = <String, dynamic>{};
    try {
      for (final layer in (job['layers'] as List).cast<Map<String, dynamic>>()) {
        final scene = scenes[layer['scene']] ?? (throw StateError('Scene "${layer['scene']}" not found. Available: ${scenes.keys.join(', ')}'));
        final region = layer['region'] as Map<String, dynamic>?;
        final canvas = layer['canvas'] as Map<String, dynamic>?;
        final dir = Directory('$workDir/${layer['id']}')..createSync(recursive: true);
        if (everyFrame) {
          for (var f = 0; f < frames; f++) {
            final visible = scene.key(f, props) != null;
            await draw(visible ? scene.build(f, props) : null, '${dir.path}/f${f.toString().padLeft(5, '0')}.png', region, canvas);
          }
          result[layer['id'] as String] = {'mode': 'sequence', 'pattern': '${dir.path}/f%05d.png', 'count': frames};
        } else {
          final segments = <Map<String, dynamic>>[];
          var start = first;
          var current = scene.key(first, props);
          for (var f = first + 1; f <= last + 1; f++) {
            final k = f <= last ? scene.key(f, props) : '\u0000end';
            if (k != current) {
              if (current != null) {
                final file = '${dir.path}/s${start.toString().padLeft(5, '0')}.png';
                await draw(scene.build(start, props), file, region, canvas);
                segments.add({'start': start, 'end': f, 'file': file});
              }
              start = f;
              current = k;
            }
          }
          result[layer['id'] as String] = {'mode': 'segments', 'segments': segments};
        }
      }
    } finally {
      debugDisableShadows = true;
      tester.view.reset();
    }
    File(job['resultFile'] as String)
        .writeAsStringSync(jsonEncode({'scenes': result, 'drawSeconds': watch.elapsedMilliseconds / 1000}));
  }, timeout: Timeout.none);
}
