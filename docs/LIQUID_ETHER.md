# Liquid Ether Animation - FULL VERSION

## Overview
Komponen `LiquidEther` adalah **FULL IMPLEMENTATION** dari fluid simulation menggunakan WebGL dan Three.js dengan Navier-Stokes equations. Ini adalah versi lengkap 1249 baris sesuai dokumentasi asli.

## ⚠️ CRITICAL WARNINGS

### Performance Impact
- **Bundle Size**: +500KB (Three.js + full fluid simulation)
- **GPU Usage**: VERY HIGH - Real fluid dynamics simulation
- **Mobile Performance**: May be SLOW on older devices
- **Battery Drain**: Significant on mobile devices

### Complexity
- **1249 lines** of complex WebGL code
- **Navier-Stokes solver** with pressure/viscosity
- **Multiple shader passes** (Advection, Divergence, Poisson, Pressure, Viscosity)
- **Frame Buffer Objects** (FBOs) for simulation
- **BFECC advection** for accuracy

## Features

### Fluid Simulation
- ✅ **Navier-Stokes Equations**: Real fluid dynamics
- ✅ **Pressure Solver**: Poisson equation solver (32 iterations)
- ✅ **Viscosity**: Optional viscous fluid simulation
- ✅ **Advection**: BFECC (Back and Forth Error Compensation and Correction)
- ✅ **Divergence**: Velocity field divergence calculation
- ✅ **Boundary Conditions**: Optional bounce at edges

### Interaction
- 🖱️ **Mouse Force**: Fluid responds to mouse movement
- 📱 **Touch Support**: Works on mobile devices
- 🤖 **Auto Demo Mode**: Automatic animation when idle
- ⚡ **Takeover Transition**: Smooth transition from auto to manual

### Visual
- 🎨 **Color Palette**: 3 colors (Violet, Pink, Purple)
- 💫 **Transparent Background**: Alpha channel support
- 🌊 **Smooth Animation**: 60 FPS target
- 📐 **Responsive**: Adapts to container size

## Implementation

### Installation
```bash
npm install three
npm install --save-dev @types/three
```

### Component Location
```
components/LiquidEther.tsx (1249 lines)
```

### Usage
```tsx
import dynamic from "next/dynamic";

const LiquidEther = dynamic(() => import("@/components/LiquidEther"), {
  ssr: false,
});

<div className="fixed inset-0 z-10 pointer-events-none">
  <LiquidEther
    colors={['#5227FF', '#FF9FFC', '#B19EEF']}
    mouseForce={20}
    cursorSize={100}
    isViscous={false}
    viscous={30}
    iterationsViscous={32}
    iterationsPoisson={32}
    resolution={0.5}
    isBounce={false}
    autoDemo={true}
    autoSpeed={0.5}
    autoIntensity={2.2}
    takeoverDuration={0.25}
    autoResumeDelay={3000}
    autoRampDuration={0.6}
  />
</div>
```

## Props

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `colors` | `string[]` | `['#5227FF', '#FF9FFC', '#B19EEF']` | Color palette |
| `mouseForce` | `number` | `20` | Mouse interaction strength |
| `cursorSize` | `number` | `100` | Cursor influence radius |
| `isViscous` | `boolean` | `false` | Enable viscosity simulation |
| `viscous` | `number` | `30` | Viscosity coefficient |
| `iterationsViscous` | `number` | `32` | Viscosity solver iterations |
| `iterationsPoisson` | `number` | `32` | Pressure solver iterations |
| `resolution` | `number` | `0.5` | Simulation resolution (0.1-1.0) |
| `isBounce` | `boolean` | `false` | Bounce at boundaries |
| `autoDemo` | `boolean` | `true` | Auto animation when idle |
| `autoSpeed` | `number` | `0.5` | Auto animation speed |
| `autoIntensity` | `number` | `2.2` | Auto animation intensity |
| `takeoverDuration` | `number` | `0.25` | Transition duration (seconds) |
| `autoResumeDelay` | `number` | `3000` | Delay before auto resumes (ms) |
| `autoRampDuration` | `number` | `0.6` | Auto ramp-up duration (seconds) |

## Technical Architecture

### Shader Passes
1. **Advection**: Move velocity field forward in time
2. **External Force**: Apply mouse/touch forces
3. **Viscous** (optional): Diffuse velocity (viscosity)
4. **Divergence**: Calculate velocity divergence
5. **Poisson**: Solve for pressure field
6. **Pressure**: Subtract pressure gradient from velocity
7. **Color**: Render final output with color mapping

### Frame Buffer Objects (FBOs)
- `vel_0`, `vel_1`: Velocity fields (ping-pong)
- `vel_viscous0`, `vel_viscous1`: Viscosity buffers
- `div`: Divergence field
- `pressure_0`, `pressure_1`: Pressure fields (ping-pong)

### Classes
- `CommonClass`: WebGL renderer management
- `MouseClass`: Input handling (mouse/touch)
- `AutoDriver`: Automatic animation
- `ShaderPass`: Base shader pass
- `Advection`: Velocity advection
- `ExternalForce`: Mouse force application
- `Viscous`: Viscosity diffusion
- `Divergence`: Divergence calculation
- `Poisson`: Pressure solver
- `Pressure`: Pressure projection
- `Simulation`: Main simulation controller
- `Output`: Final rendering
- `WebGLManager`: Overall manager

## Performance Optimization

### Recommended Settings for Production
```tsx
<LiquidEther
  resolution={0.3}  // Lower = faster
  iterationsPoisson={16}  // Lower = faster
  isViscous={false}  // Disable for better performance
  autoDemo={true}  // Reduce GPU usage when idle
/>
```

### For Mobile
```tsx
<LiquidEther
  resolution={0.25}
  iterationsPoisson={8}
  mouseForce={15}
  isViscous={false}
/>
```

## Browser Compatibility
- ✅ Chrome, Firefox, Safari, Edge (latest)
- ✅ WebGL 1.0 required
- ⚠️ May be slow on integrated GPUs
- ❌ No fallback for non-WebGL browsers

## Troubleshooting

### Performance Issues
1. **Lower resolution**: `resolution={0.25}`
2. **Reduce iterations**: `iterationsPoisson={8}`
3. **Disable viscosity**: `isViscous={false}`
4. **Check GPU usage** in browser DevTools

### Not Visible
- Ensure container has dimensions
- Check z-index layering
- Verify WebGL support in browser
- Check browser console for errors

### High CPU/GPU Usage
- This is EXPECTED - it's a real fluid simulation
- Consider using simpler ParticleBackground instead
- Enable auto demo to reduce usage when idle

## Comparison: Full vs Simplified

| Feature | Full (This) | Simplified |
|---------|-------------|------------|
| Lines of Code | 1249 | ~200 |
| Navier-Stokes | ✅ | ❌ |
| Pressure Solver | ✅ | ❌ |
| Viscosity | ✅ | ❌ |
| Advection | ✅ BFECC | ❌ |
| Bundle Size | ~500KB | ~200KB |
| GPU Usage | Very High | Medium |
| Realism | Excellent | Good |
| Recommended | Production with caution | General use |

## Migration Back to Particles

If performance is an issue:

```tsx
// Replace in app/page.tsx
const ParticleBackground = dynamic(() => import("@/components/ParticleBackground"), {
  ssr: false,
});

<ParticleBackground />
```

## Credits
- Based on Liquid Ether fluid simulation
- Implements Navier-Stokes equations
- Uses Three.js for WebGL rendering
- BFECC advection for accuracy
- Poisson solver for pressure

## License
Check original Liquid Ether license for usage terms.
