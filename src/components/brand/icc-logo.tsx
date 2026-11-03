import Image from 'next/image';

import { cn } from '@/lib/utils';

// The ICC (Indonesian Certification Center) logo, shipped as PNG in
// /public/brand. The artwork is dark blue and orange on white, which is
// unreadable straight on the dark theme, so it is always shown on a white
// rounded tile. `unoptimized` serves the file as it is: it is small and the
// optimizer needs extra native libraries in the standalone Docker image.

export const BRAND_NAME = 'Indonesian Certification Center';

const FULL = { src: '/brand/icc-logo.png', width: 548, height: 212 };
const MARK = { src: '/brand/icc-mark.png', width: 207, height: 207 };

interface IccLogoProps {
  /** `full`: emblem + "ICC" + name. `mark`: the emblem alone. */
  variant?: 'full' | 'mark';
  /** Sizes the tile. Give a height (and, for `mark`, a width) such as `h-10`. */
  className?: string;
}

export function IccLogo({ variant = 'full', className }: IccLogoProps) {
  const art = variant === 'mark' ? MARK : FULL;
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center justify-center overflow-hidden rounded-lg bg-white p-1 ring-1 ring-black/5',
        className,
      )}
    >
      <Image
        src={art.src}
        width={art.width}
        height={art.height}
        alt={BRAND_NAME}
        unoptimized
        priority={variant === 'full'}
        className="h-full w-auto object-contain"
      />
    </span>
  );
}
