/**
 * Preetham analytic daylight model shared by the sky dome and the fog post effect,
 * adapted from three.js examples/jsm/objects/Sky.js (MIT). Output is pre-multiplied by
 * the same 0.04 exposure Sky.js uses; scale with uSkyExposure.
 */
export const SKY_GLSL = /* glsl */ `
uniform vec3 uSunDir;
uniform float uRayleigh;
uniform float uTurbidity;
uniform float uMie;
uniform float uMieG;
uniform float uSkyExposure;

const float SKY_PI = 3.141592653589793;
const vec3 SKY_TOTAL_RAYLEIGH = vec3(5.804542996261093E-6, 1.3562911419845635E-5, 3.0265902468824876E-5);
const vec3 SKY_MIE_CONST = vec3(1.8399918514433978E14, 2.7798023919660528E14, 4.0790479543861094E14);
const float SKY_CUTOFF = 1.6110731556870734;
const float SKY_STEEP = 1.5;
const float SKY_EE = 1000.0;

float skySunIntensity(float zenithAngleCos) {
  zenithAngleCos = clamp(zenithAngleCos, -1.0, 1.0);
  return SKY_EE * max(0.0, 1.0 - pow(2.718281828, -((SKY_CUTOFF - acos(zenithAngleCos)) / SKY_STEEP)));
}

vec3 skyBetaR() {
  vec3 sunDir = normalize(uSunDir);
  float sunfade = 1.0 - clamp(1.0 - exp(sunDir.y), 0.0, 1.0);
  return SKY_TOTAL_RAYLEIGH * (uRayleigh - (1.0 - sunfade));
}

vec3 skyBetaM() {
  float c = (0.2 * uTurbidity) * 10E-18;
  return 0.434 * c * SKY_MIE_CONST * uMie;
}

float skyHg(float cosTheta, float g) {
  float g2 = g * g;
  return 0.07957747154594767 * ((1.0 - g2) / pow(1.0 - 2.0 * g * cosTheta + g2, 1.5));
}

/** Sky radiance (without sun disc) for a view direction. */
vec3 skyRadianceFex(vec3 direction, out vec3 FexOut, out vec3 LinOut) {
  vec3 sunDir = normalize(uSunDir);
  vec3 betaR = skyBetaR();
  vec3 betaM = skyBetaM();
  float sunE = skySunIntensity(sunDir.y);
  float zenithAngle = acos(max(0.0, direction.y));
  float inv = 1.0 / (cos(zenithAngle) + 0.15 * pow(93.885 - ((zenithAngle * 180.0) / SKY_PI), -1.253));
  float sR = 8.4E3 * inv;
  float sM = 1.25E3 * inv;
  vec3 Fex = exp(-(betaR * sR + betaM * sM));
  float cosTheta = dot(direction, sunDir);
  float rPhase = 0.05968310365946075 * (1.0 + pow(cosTheta * 0.5 + 0.5, 2.0));
  vec3 betaRTheta = betaR * rPhase;
  vec3 betaMTheta = betaM * skyHg(cosTheta, uMieG);
  vec3 Lin = pow(sunE * ((betaRTheta + betaMTheta) / (betaR + betaM)) * (1.0 - Fex), vec3(1.5));
  Lin *= mix(vec3(1.0), pow(sunE * ((betaRTheta + betaMTheta) / (betaR + betaM)) * Fex, vec3(0.5)), clamp(pow(1.0 - sunDir.y, 5.0), 0.0, 1.0));
  vec3 L0 = vec3(0.1) * Fex;
  FexOut = Fex;
  LinOut = Lin;
  return (Lin + L0) * 0.04 + vec3(0.0, 0.0003, 0.00075);
}

vec3 skyRadiance(vec3 direction) {
  vec3 f; vec3 l;
  return skyRadianceFex(direction, f, l);
}
`;
