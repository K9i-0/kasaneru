import 'dart:math' as math;

/// A damped spring going from 0 to 1. Uses the closed-form solution of the equation of motion (no numerical integration).
double spring({required int frame, required double fps, double damping = 10, double stiffness = 100, double mass = 1}) {
  final t = math.max(0, frame) / fps;
  final w0 = math.sqrt(stiffness / mass);
  final zeta = damping / (2 * math.sqrt(stiffness * mass));
  if (zeta < 1) {
    final wd = w0 * math.sqrt(1 - zeta * zeta);
    return 1 - math.exp(-zeta * w0 * t) * (math.cos(wd * t) + (zeta * w0 / wd) * math.sin(wd * t));
  }
  if (zeta == 1) return 1 - math.exp(-w0 * t) * (1 + w0 * t);
  final s = math.sqrt(zeta * zeta - 1);
  final r1 = -w0 * (zeta - s), r2 = -w0 * (zeta + s);
  return 1 - (r2 * math.exp(r1 * t) - r1 * math.exp(r2 * t)) / (r2 - r1);
}

/// Once the motion has stopped, snap to the same value so that those frames are drawn only once, as the same picture.
double settle(double value, {double target = 1, int digits = 3}) {
  final q = double.parse(value.toStringAsFixed(digits));
  return (q - target).abs() <= 2 * math.pow(10, -digits) ? target : q;
}
