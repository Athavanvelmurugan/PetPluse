import os
from PIL import Image, ImageDraw

def generate_icons():
    source_path = 'frontend/public/petpulse-logo.png'
    if not os.path.exists(source_path):
        source_path = 'frontend/public/petpulse-badge.png'
    
    print(f"Loading master logo from {source_path}...")
    master = Image.open(source_path).convert('RGBA')
    
    res_dir = 'frontend/android/app/src/main/res'
    
    # 1. Launcher icons
    densities = {
        'mipmap-mdpi': (48, 108),
        'mipmap-hdpi': (72, 162),
        'mipmap-xhdpi': (96, 216),
        'mipmap-xxhdpi': (144, 324),
        'mipmap-xxxhdpi': (192, 432),
    }
    
    for folder, (icon_size, fg_size) in densities.items():
        target_dir = os.path.join(res_dir, folder)
        os.makedirs(target_dir, exist_ok=True)
        
        # A. ic_launcher.png (Standard launcher icon)
        launcher = Image.new('RGBA', (icon_size, icon_size), (0, 0, 0, 0))
        logo_resized = master.resize((icon_size, icon_size), Image.Resampling.LANCZOS)
        launcher.paste(logo_resized, (0, 0), logo_resized)
        launcher.save(os.path.join(target_dir, 'ic_launcher.png'), 'PNG')
        
        # B. ic_launcher_round.png (Circular launcher icon)
        round_icon = Image.new('RGBA', (icon_size, icon_size), (0, 0, 0, 0))
        round_icon.paste(logo_resized, (0, 0), logo_resized)
        
        # Circular mask
        mask = Image.new('L', (icon_size, icon_size), 0)
        draw = ImageDraw.Draw(mask)
        draw.ellipse((0, 0, icon_size, icon_size), fill=255)
        
        # Apply mask
        final_round = Image.new('RGBA', (icon_size, icon_size), (0, 0, 0, 0))
        final_round.paste(round_icon, (0, 0), mask=mask)
        final_round.save(os.path.join(target_dir, 'ic_launcher_round.png'), 'PNG')
        
        # C. ic_launcher_foreground.png (Adaptive icon foreground)
        fg_canvas = Image.new('RGBA', (fg_size, fg_size), (0, 0, 0, 0))
        # Place logo in safe zone (65% of foreground canvas)
        safe_logo_size = int(fg_size * 0.65)
        logo_fg = master.resize((safe_logo_size, safe_logo_size), Image.Resampling.LANCZOS)
        offset = (fg_size - safe_logo_size) // 2
        fg_canvas.paste(logo_fg, (offset, offset), logo_fg)
        fg_canvas.save(os.path.join(target_dir, 'ic_launcher_foreground.png'), 'PNG')
        
        print(f"Generated {folder}: ic_launcher ({icon_size}x{icon_size}), round, foreground ({fg_size}x{fg_size})")

    # 2. Splash screens
    splash_dirs = {
        'drawable-port-mdpi': (320, 480),
        'drawable-port-hdpi': (480, 800),
        'drawable-port-xhdpi': (720, 1280),
        'drawable-port-xxhdpi': (960, 1600),
        'drawable-port-xxxhdpi': (1280, 1920),
        'drawable-land-mdpi': (480, 320),
        'drawable-land-hdpi': (800, 480),
        'drawable-land-xhdpi': (1280, 720),
        'drawable-land-xxhdpi': (1600, 960),
        'drawable-land-xxxhdpi': (1920, 1280),
    }
    
    for folder, (w, h) in splash_dirs.items():
        target_dir = os.path.join(res_dir, folder)
        os.makedirs(target_dir, exist_ok=True)
        
        splash = Image.new('RGBA', (w, h), (255, 255, 255, 255))
        logo_dim = int(min(w, h) * 0.40)
        splash_logo = master.resize((logo_dim, logo_dim), Image.Resampling.LANCZOS)
        offset_x = (w - logo_dim) // 2
        offset_y = (h - logo_dim) // 2
        splash.paste(splash_logo, (offset_x, offset_y), splash_logo)
        
        splash.convert('RGB').save(os.path.join(target_dir, 'splash.png'), 'PNG')
        print(f"Generated splash for {folder} ({w}x{h})")

    print("\nAll Android icons and splash assets successfully generated!")

if __name__ == '__main__':
    generate_icons()
