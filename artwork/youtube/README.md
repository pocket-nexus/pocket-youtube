# YouTube source artwork

The icon and wordmark retain YouTube's vector geometry and aspect ratio.

- Official brand site: https://brand.youtube/
- Logo source: https://brand.youtube/youtube-logo
- Official ZIP: https://www.gstatic.com/marketing-cms/52/7d/637fef5a4788a97747e6feabc4aa/youtube-logo.zip
- ZIP member: `YouTube_Logo/Digital/01 Full Color/yt_logo_fullcolor_white_digital.ai`.
- `logo-white.svg` is a vector conversion of that PDF-compatible AI file using
  `pdftocairo -svg official-logo.ai artwork/youtube/logo-white.svg`.
- `icon.svg` is the inline 37×26 SVG from the official brand site's component
  `https://www.gstatic.com/marketing-cms/reviewed-scripts/prod/yt-components-1.0.3-714dc0a/styles/default/All.min.js`.
  Attribute quoting was normalized; both path definitions are unchanged.

Retrieved September 10, 2026. YouTube and its logo are trademarks of Google LLC.
The app does not imply endorsement. The official download contains AI, EPS,
PDF and PNG assets; the committed SVG preserves the official vector outlines.

Run `bun run bake:classic` to rasterize the vectors and authored interface skins.
The full logo is alpha-cropped to its artwork bounds, fitted to 220×49 pixels,
and stored in a transparent 256×64 texture. The icon occupies 64×45 pixels in
its 64×64 texture. Draw the full texture with clipping, or scale the square icon
as one image; neither operation changes the artwork's proportions.
