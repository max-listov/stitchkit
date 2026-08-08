CREATE TYPE "RepositoryVisibility" AS ENUM ('PUBLIC', 'PRIVATE', 'INTERNAL');

ALTER TABLE "RepositorySnapshot"
ADD COLUMN "visibility" "RepositoryVisibility" NOT NULL DEFAULT 'PUBLIC';
