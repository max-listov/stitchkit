CREATE TABLE "RepositorySnapshot" (
    "fullName" TEXT NOT NULL,
    "description" TEXT,
    "htmlUrl" TEXT NOT NULL,
    "language" TEXT,
    "stars" INTEGER NOT NULL,
    "forks" INTEGER NOT NULL,
    "openIssues" INTEGER NOT NULL,
    "commitCount" INTEGER NOT NULL,
    "latestCommitSha" TEXT,
    "latestCommitMessage" TEXT,
    "latestCommittedAt" TIMESTAMP(3),
    "fetchedAt" TIMESTAMP(3) NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "RepositorySnapshot_pkey" PRIMARY KEY ("fullName")
);
