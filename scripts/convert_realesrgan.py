# Converts official Real-ESRGAN RRDBNet .pth weights to fp32 ONNX with
# dynamic H/W axes, for onnxruntime-web (webgpu/wasm) tiled inference.
#
# This is how public/models/realesrgan-x4plus-anime6b.onnx and
# realesrgan-x4plus.onnx were produced. Weights (BSD-3):
#   https://github.com/xinntao/Real-ESRGAN/releases/download/v0.2.2.4/RealESRGAN_x4plus_anime_6B.pth
#   https://github.com/xinntao/Real-ESRGAN/releases/download/v0.1.0/RealESRGAN_x4plus.pth
# Usage: pip install torch onnx numpy
#        python convert_realesrgan.py <weights_dir> <output_dir>
#
# Weights are loaded with weights_only=True (tensor data only, no pickle code
# execution). Architecture is defined standalone below (BasicSR RRDBNet,
# scale=4 variant -- no pixel_unshuffle path needed).
import sys
import torch
import torch.nn as nn
import torch.nn.functional as F


class ResidualDenseBlock(nn.Module):
    def __init__(self, num_feat=64, num_grow_ch=32):
        super().__init__()
        self.conv1 = nn.Conv2d(num_feat, num_grow_ch, 3, 1, 1)
        self.conv2 = nn.Conv2d(num_feat + num_grow_ch, num_grow_ch, 3, 1, 1)
        self.conv3 = nn.Conv2d(num_feat + 2 * num_grow_ch, num_grow_ch, 3, 1, 1)
        self.conv4 = nn.Conv2d(num_feat + 3 * num_grow_ch, num_grow_ch, 3, 1, 1)
        self.conv5 = nn.Conv2d(num_feat + 4 * num_grow_ch, num_feat, 3, 1, 1)
        self.lrelu = nn.LeakyReLU(negative_slope=0.2, inplace=True)

    def forward(self, x):
        x1 = self.lrelu(self.conv1(x))
        x2 = self.lrelu(self.conv2(torch.cat((x, x1), 1)))
        x3 = self.lrelu(self.conv3(torch.cat((x, x1, x2), 1)))
        x4 = self.lrelu(self.conv4(torch.cat((x, x1, x2, x3), 1)))
        x5 = self.conv5(torch.cat((x, x1, x2, x3, x4), 1))
        return x5 * 0.2 + x


class RRDB(nn.Module):
    def __init__(self, num_feat, num_grow_ch=32):
        super().__init__()
        self.rdb1 = ResidualDenseBlock(num_feat, num_grow_ch)
        self.rdb2 = ResidualDenseBlock(num_feat, num_grow_ch)
        self.rdb3 = ResidualDenseBlock(num_feat, num_grow_ch)

    def forward(self, x):
        out = self.rdb3(self.rdb2(self.rdb1(x)))
        return out * 0.2 + x


class RRDBNet(nn.Module):
    def __init__(self, num_in_ch=3, num_out_ch=3, num_feat=64, num_block=23, num_grow_ch=32):
        super().__init__()
        self.conv_first = nn.Conv2d(num_in_ch, num_feat, 3, 1, 1)
        self.body = nn.Sequential(*[RRDB(num_feat, num_grow_ch) for _ in range(num_block)])
        self.conv_body = nn.Conv2d(num_feat, num_feat, 3, 1, 1)
        self.conv_up1 = nn.Conv2d(num_feat, num_feat, 3, 1, 1)
        self.conv_up2 = nn.Conv2d(num_feat, num_feat, 3, 1, 1)
        self.conv_hr = nn.Conv2d(num_feat, num_feat, 3, 1, 1)
        self.conv_last = nn.Conv2d(num_feat, num_out_ch, 3, 1, 1)
        self.lrelu = nn.LeakyReLU(negative_slope=0.2, inplace=True)

    def forward(self, x):
        feat = self.conv_first(x)
        body_feat = self.conv_body(self.body(feat))
        feat = feat + body_feat
        feat = self.lrelu(self.conv_up1(F.interpolate(feat, scale_factor=2, mode='nearest')))
        feat = self.lrelu(self.conv_up2(F.interpolate(feat, scale_factor=2, mode='nearest')))
        out = self.conv_last(self.lrelu(self.conv_hr(feat)))
        return out


def convert(pth_path, onnx_path, num_block):
    state = torch.load(pth_path, map_location='cpu', weights_only=True)
    if 'params_ema' in state:
        state = state['params_ema']
    elif 'params' in state:
        state = state['params']
    model = RRDBNet(num_block=num_block)
    model.load_state_dict(state, strict=True)
    model.eval()

    dummy = torch.randn(1, 3, 64, 64)
    torch.onnx.export(
        model, dummy, onnx_path,
        input_names=['input'], output_names=['output'],
        dynamic_axes={'input': {0: 'batch', 2: 'height', 3: 'width'},
                      'output': {0: 'batch', 2: 'out_height', 3: 'out_width'}},
        opset_version=17,
        dynamo=False,
    )
    print(f'exported {onnx_path} (blocks={num_block})')


if __name__ == '__main__':
    weights_dir = sys.argv[1]
    out_dir = sys.argv[2]
    convert(f'{weights_dir}/RealESRGAN_x4plus_anime_6B.pth',
            f'{out_dir}/realesrgan-x4plus-anime6b.onnx', num_block=6)
    convert(f'{weights_dir}/RealESRGAN_x4plus.pth',
            f'{out_dir}/realesrgan-x4plus.onnx', num_block=23)
