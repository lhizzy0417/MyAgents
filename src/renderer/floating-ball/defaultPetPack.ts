import minoSpritesheetUrl from '@/assets/floating-pets/mino/spritesheet.webp';

import { CODEX_PET_ATLAS, type PetPack } from './petAtlas';

export const MINO_DEFAULT_PET_PACK: PetPack = {
    id: 'mino-default',
    displayName: 'Mino',
    spritesheetUrl: minoSpritesheetUrl,
    atlas: CODEX_PET_ATLAS,
};
