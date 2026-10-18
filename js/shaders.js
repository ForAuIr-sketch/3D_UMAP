/* ==========================================================================
 * shaders.js — GLSL for the cell point cloud and for the density shells.
 *
 * Point rendering
 *   vertex   : size attenuation (POINT_SIZE behaves like "pixels at the default
 *              camera distance"), optional density boost, focus dimming
 *   fragment : radial Gaussian falloff from gl_PointCoord -> soft round sprite
 *              with a bright core and a fully transparent rim
 *
 * Shell rendering (density isosurface)
 *   fragment : rim/fresnel term so only the silhouette glows -> the cluster
 *              outline stays visible without hiding the cells inside
 * ========================================================================== */

/* ------------------------------- POINTS ---------------------------------- */

export const pointsVertexShader = /* glsl */`
  attribute float aType;      // index of the CellMajortype (0..n-1)
  attribute float aDensity;   // 0..1 local density, computed from the real coords
  attribute vec3  aColor;     // per-cell colour taken from the palette

  uniform float uPointSize;     // POINT_SIZE
  uniform float uPixelRatio;    // renderer pixel ratio
  uniform float uRefDistance;   // camera distance that POINT_SIZE refers to
  uniform float uFocus;         // focused type index, -1 = none
  uniform float uDim;           // opacity factor for the non-focused types
  uniform float uDensityBoost;  // DENSITY_BOOST

  varying vec3  vColor;
  varying float vAlpha;

  void main() {
    vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);

    float dist = max(0.0001, -mvPosition.z);
    float sizeScale = uRefDistance / dist;                      // perspective attenuation
    float dense = 1.0 + uDensityBoost * aDensity * 0.45;        // dense regions slightly larger
    gl_PointSize = uPointSize * uPixelRatio * sizeScale * dense;
    gl_PointSize = clamp(gl_PointSize, 0.6, 90.0);

    vColor = aColor;
    float focused = (uFocus < -0.5) ? 1.0 : (abs(aType - uFocus) < 0.5 ? 1.0 : uDim);
    float brightness = 0.72 + 0.55 * aDensity * uDensityBoost;  // dense regions slightly brighter
    vAlpha = focused * brightness;

    gl_Position = projectionMatrix * mvPosition;
  }
`;

export const pointsFragmentShader = /* glsl */`
  precision highp float;

  uniform float uOpacity;   // POINT_OPACITY

  varying vec3  vColor;
  varying float vAlpha;

  void main() {
    // radial distance from the sprite centre, 0 at centre, 1 at the border
    vec2 uv = gl_PointCoord - vec2(0.5);
    float d = length(uv) * 2.0;
    if (d > 1.0) discard;

    // Soft round light spot:
    //   body  – Gaussian falloff, the main "fluorescent blob"
    //   core  – small, slightly brighter centre (kept low so dense areas do not
    //           wash out to pure white; ACES tone mapping rolls off the rest)
    //   rim   – forces a fully transparent border so single cells stay separable
    float body = exp(-2.6 * d * d);
    float core = pow(max(0.0, 1.0 - d), 8.0) * 0.25;
    float rim  = 1.0 - smoothstep(0.74, 1.0, d);
    float alpha = (body * 0.92 + core) * rim * uOpacity * vAlpha;
    if (alpha < 0.002) discard;

    gl_FragColor = vec4(vColor, alpha);
  }
`;

/* ------------------------------- SURFACES -------------------------------- */

export const surfaceVertexShader = /* glsl */`
  varying vec3 vNormalV;   // normal in view space
  varying vec3 vViewDir;   // direction from the surface to the camera (view space)

  void main() {
    vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
    vNormalV = normalize(normalMatrix * normal);
    vViewDir = normalize(-mvPosition.xyz);
    gl_Position = projectionMatrix * mvPosition;
  }
`;

export const surfaceFragmentShader = /* glsl */`
  precision highp float;

  uniform vec3  uColor;      // colour of this CellMajortype
  uniform float uOpacity;    // SURFACE_OPACITY
  uniform float uRimPower;   // SURFACE_FRESNEL_POWER
  uniform float uGlow;       // SURFACE_GLOW_STRENGTH
  uniform float uInterior;   // SURFACE_INTERIOR (body visibility, kept very low)
  uniform float uType;       // index of this CellMajortype
  uniform float uFocus;      // focused type index, -1 = none
  uniform float uDim;        // opacity factor applied to the non-focused types

  varying vec3 vNormalV;
  varying vec3 vViewDir;

  void main() {
    // Fresnel term: ~0 when the shell faces the camera, 1 at the silhouette.
    // The body stays almost invisible; the outline carries the whole effect, so
    // the shell reads as a glowing membrane instead of a solid plastic surface.
    float facing = abs(dot(normalize(vNormalV), normalize(vViewDir)));
    float rim = pow(1.0 - facing, uRimPower);

    float focused = (uFocus < -0.5) ? 1.0 : (abs(uType - uFocus) < 0.5 ? 1.0 : uDim);
    float alpha = uOpacity * (uInterior + uGlow * rim) * focused;
    if (alpha < 0.001) discard;

    // the rim is slightly whitened so the outline reads as a soft halo
    vec3 col = mix(uColor, vec3(1.0), 0.22 * rim);
    gl_FragColor = vec4(col, alpha);
  }
`;

/* ==========================================================================
 * WHITE BACKGROUND VARIANTS
 *
 * A white page is a different medium: additive light does not exist there, so
 * the dark-mode sprite cannot simply be re-used (every cluster washes out to a
 * near-white pastel). These shaders draw "translucent coloured ink" instead:
 *   - the centre highlight is removed completely (it is what turns a dense
 *     pile of cells white),
 *   - the sprite colour comes from the CellMajortype hue pushed to a darker,
 *     slightly more saturated ink colour (computed in JS, never a white mix),
 *   - opacity GROWS with local density, so dense regions become deeper and more
 *     saturated instead of brighter,
 *   - an optional same-hue halo (never white) softens the outer edge.
 * Dark and Black keep using the original shaders above, untouched.
 * ======================================================================== */

export const whitePointsVertexShader = /* glsl */`
  attribute float aType;
  attribute float aDensity;
  attribute vec3  aColor;

  uniform float uPointSize;
  uniform float uPixelRatio;
  uniform float uRefDistance;
  uniform float uFocus;
  uniform float uDim;
  uniform float uDensityAlpha;   // extra opacity in dense regions (white mode)

  varying vec3  vColor;
  varying float vAlpha;

  void main() {
    vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
    float dist = max(0.0001, -mvPosition.z);
    float sizeScale = uRefDistance / dist;
    gl_PointSize = uPointSize * uPixelRatio * sizeScale * (1.0 + 0.30 * aDensity);
    gl_PointSize = clamp(gl_PointSize, 0.6, 90.0);

    vColor = aColor;
    float focused = (uFocus < -0.5) ? 1.0 : (abs(aType - uFocus) < 0.5 ? 1.0 : uDim);
    // density -> MORE opacity (deeper ink), never brighter colour
    vAlpha = focused * (1.0 + uDensityAlpha * aDensity);

    gl_Position = projectionMatrix * mvPosition;
  }
`;

export const whitePointsFragmentShader = /* glsl */`
  precision highp float;

  uniform float uOpacity;      // POINT_OPACITY x WHITE_POINT_OPACITY_MULTIPLIER
  uniform float uHalo;         // WHITE_HALO_STRENGTH  (same-hue halo, never white)

  varying vec3  vColor;
  varying float vAlpha;

  void main() {
    vec2 uv = gl_PointCoord - vec2(0.5);
    float d = length(uv) * 2.0;
    if (d > 1.0) discard;

    float ink  = exp(-4.2 * d * d);                    // crisp coloured core
    float halo = exp(-1.7 * d * d) * (1.0 - smoothstep(0.55, 1.0, d));
    float rim  = 1.0 - smoothstep(0.82, 1.0, d);

    // no white highlight term at all: the ink keeps its hue at any density
    float alpha = (ink + uHalo * halo) * rim * uOpacity * vAlpha;
    if (alpha < 0.002) discard;

    gl_FragColor = vec4(vColor, clamp(alpha, 0.0, 1.0));
  }
`;

export const whiteSurfaceVertexShader = /* glsl */`
  varying vec3 vNormalV;
  varying vec3 vViewDir;
  void main() {
    vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
    vNormalV = normalize(normalMatrix * normal);
    vViewDir = normalize(-mvPosition.xyz);
    gl_Position = projectionMatrix * mvPosition;
  }
`;

export const whiteSurfaceFragmentShader = /* glsl */`
  precision highp float;

  uniform vec3  uColor;      // already the DARKENED CellMajortype colour
  uniform float uOpacity;    // WHITE_SURFACE_OPACITY
  uniform float uRimPower;
  uniform float uInterior;   // ~0 -> only a thin contour stays visible
  uniform float uType;
  uniform float uFocus;
  uniform float uDim;

  varying vec3 vNormalV;
  varying vec3 vViewDir;

  void main() {
    float facing = abs(dot(normalize(vNormalV), normalize(vViewDir)));
    float rim = pow(1.0 - facing, uRimPower);
    float focused = (uFocus < -0.5) ? 1.0 : (abs(uType - uFocus) < 0.5 ? 1.0 : uDim);

    // thin coloured contour: no white highlight, no grey outline
    float alpha = uOpacity * (uInterior + rim) * focused;
    if (alpha < 0.001) discard;
    gl_FragColor = vec4(uColor, alpha);
  }
`;
