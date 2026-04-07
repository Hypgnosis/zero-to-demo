import sys
try:
    from PIL import Image
    import numpy as np
except ImportError:
    import subprocess
    subprocess.check_call([sys.executable, "-m", "pip", "install", "Pillow", "numpy"])
    from PIL import Image
    import numpy as np

try:
    img = Image.open('public/Axiom-0 Logo.png').convert('RGBA')
    data = np.array(img)

    # Top-left pixel is a good sample of the solid background
    bg_color = data[0, 0]

    r, g, b = data[:,:,0].astype(int), data[:,:,1].astype(int), data[:,:,2].astype(int)
    dist = np.sqrt((r - bg_color[0])**2 + (g - bg_color[1])**2 + (b - bg_color[2])**2)

    # Make pixels very close to the background color fully transparent
    a = data[:,:,3]
    # Adjusting threshold to remove compression artifacts gracefully
    data[:,:,3] = np.where(dist < 20, 0, a)

    # Optional: feathering or anti-aliasing could be added here, but a sharp cutoff
    # usually suffices for black background logos shown on dark webs.

    img_new = Image.fromarray(data)
    img_new.save('public/Axiom-0 Logo.png')
    print('Background successfully removed from Axiom-0 Logo.png!')
except Exception as e:
    print(f'Error: {e}')
