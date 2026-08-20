#include <metal_stdlib>
using namespace metal;

struct OverlayParameters {
    float2 labelPosition;
    float2 labelSize;
};

constant sampler linearSampler(filter::linear, coord::pixel, address::clamp_to_edge);

/**
 * Copie un angle sans le mélanger à l'autre caméra, puis incruste son bandeau
 * d'identification. Le même kernel est appliqué séparément au flux avant et au
 * flux arrière.
 */
kernel void prepaTrackCameraOverlay(
    texture2d<half, access::read> cameraInput [[texture(0)]],
    texture2d<half, access::sample> labelInput [[texture(1)]],
    texture2d<half, access::write> outputTexture [[texture(2)]],
    constant OverlayParameters& parameters [[buffer(0)]],
    uint2 gid [[thread_position_in_grid]]
) {
    if (gid.x >= outputTexture.get_width() || gid.y >= outputTexture.get_height()) {
        return;
    }

    half4 output = cameraInput.read(gid);
    float2 point = float2(gid);
    bool insideLabel = all(point >= parameters.labelPosition) &&
        all(point < parameters.labelPosition + parameters.labelSize);
    if (insideLabel) {
        float2 local = point - parameters.labelPosition;
        float2 sampling = local *
            float2(labelInput.get_width(), labelInput.get_height()) / parameters.labelSize;
        half4 label = labelInput.sample(linearSampler, sampling + 0.5);
        output = label + output * (1.0h - label.a);
    }

    outputTexture.write(output, gid);
}
