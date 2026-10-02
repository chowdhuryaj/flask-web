// electron-builder afterPack hook: flip Electron fuses on the packaged binary.
// electron-builder 25 has no native electronFuses option (it arrived in 26),
// so this uses @electron/fuses directly. Verify with
//   npx @electron/fuses read --app dist/mac-arm64/Totem-Flask.app
const path = require('path');
const { flipFuses, FuseVersion, FuseV1Options } = require('@electron/fuses');

exports.default = async function afterPack(ctx) {
    const name = ctx.packager.appInfo.productFilename;
    const bin = ctx.electronPlatformName === 'darwin'
        ? path.join(ctx.appOutDir, `${name}.app`)
        : path.join(ctx.appOutDir, ctx.electronPlatformName === 'win32' ? `${name}.exe` : name);
    await flipFuses(bin, {
        version: FuseVersion.V1,
        // Flipping invalidates the ad-hoc signature; dist:dir re-signs after.
        resetAdHocDarwinSignature: ctx.electronPlatformName === 'darwin',
        [FuseV1Options.RunAsNode]: false,
        [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
        [FuseV1Options.EnableNodeCliInspectArguments]: false,
        [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
        [FuseV1Options.OnlyLoadAppFromAsar]: true,
        [FuseV1Options.EnableCookieEncryption]: true,
    });
};
