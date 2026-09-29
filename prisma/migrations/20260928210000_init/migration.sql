-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('admin', 'user');

-- CreateEnum
CREATE TYPE "ArticleStatus" AS ENUM ('draft', 'scheduled', 'published');

-- CreateEnum
CREATE TYPE "ArticleSource" AS ENUM ('human', 'ai');

-- CreateEnum
CREATE TYPE "ArticleType" AS ENUM ('pillar', 'cluster', 'micro', 'insight', 'observant');

-- CreateEnum
CREATE TYPE "ReactionType" AS ENUM ('like', 'love', 'insightful');

-- CreateEnum
CREATE TYPE "CommentStatus" AS ENUM ('approved', 'pending', 'spam', 'removed');

-- CreateEnum
CREATE TYPE "EmailQueueStatus" AS ENUM ('pending', 'sending', 'sent', 'failed');

-- CreateEnum
CREATE TYPE "ResearchTopicStatus" AS ENUM ('pending', 'processed');

-- CreateEnum
CREATE TYPE "OtpCodeType" AS ENUM ('password_reset', 'password_change');

-- CreateEnum
CREATE TYPE "AiTestStatus" AS ENUM ('success', 'failed');

-- CreateTable
CREATE TABLE "globalStats" (
    "id" TEXT NOT NULL DEFAULT 'global_stats',
    "articleCount" INTEGER NOT NULL DEFAULT 0,
    "publishedArticleCount" INTEGER NOT NULL DEFAULT 0,
    "draftArticleCount" INTEGER NOT NULL DEFAULT 0,
    "scheduledArticleCount" INTEGER NOT NULL DEFAULT 0,
    "aiDraftCount" INTEGER NOT NULL DEFAULT 0,
    "usersCount" INTEGER NOT NULL DEFAULT 0,
    "commentsCount" INTEGER NOT NULL DEFAULT 0,
    "pendingCommentsCount" INTEGER NOT NULL DEFAULT 0,
    "totalViews" INTEGER NOT NULL DEFAULT 0,
    "totalUniqueViews" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "globalStats_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "email" VARCHAR(320) NOT NULL,
    "password" VARCHAR(60),
    "profileImage" TEXT,
    "provider" TEXT NOT NULL,
    "role" "UserRole" NOT NULL,
    "emailVerified" BOOLEAN,
    "newsletterSubscribed" BOOLEAN NOT NULL DEFAULT false,
    "emailConfirmed" BOOLEAN,
    "confirmationToken" TEXT,
    "resetToken" TEXT,
    "resetTokenExpires" TIMESTAMPTZ(3),
    "completedTours" TEXT[],
    "createdAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "quotes" (
    "id" UUID NOT NULL,
    "text" TEXT NOT NULL,
    "author" TEXT NOT NULL,
    "category" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "quotes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "articles" (
    "id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "slug" VARCHAR(255) NOT NULL,
    "excerpt" TEXT,
    "content" TEXT,
    "coverImage" TEXT,
    "coverImageAlt" TEXT,
    "authorId" UUID NOT NULL,
    "categoryId" UUID,
    "pillar" VARCHAR(255),
    "topics" TEXT[],
    "tags" TEXT[],
    "type" "ArticleType",
    "status" "ArticleStatus" NOT NULL,
    "source" "ArticleSource" NOT NULL,
    "scheduledFor" TIMESTAMPTZ(3),
    "publishedAt" TIMESTAMPTZ(3),
    "viewCount" INTEGER NOT NULL DEFAULT 0,
    "uniqueViewCount" INTEGER NOT NULL DEFAULT 0,
    "reactionsCount" INTEGER,
    "readingTime" INTEGER NOT NULL,
    "actualReadingTime" INTEGER,
    "metaTitle" TEXT,
    "metaDescription" TEXT,
    "focusKeyword" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "isFeatured" BOOLEAN,
    "isArchived" BOOLEAN,
    "searchVector" tsvector,

    CONSTRAINT "articles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "categories" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "slug" VARCHAR(255) NOT NULL,
    "description" TEXT,
    "coverImage" TEXT,
    "pexelsImages" TEXT[],
    "articleCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "comments" (
    "id" UUID NOT NULL,
    "articleId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "parentId" UUID,
    "content" TEXT NOT NULL,
    "status" "CommentStatus" NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "comments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reactions" (
    "id" UUID NOT NULL,
    "articleId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "type" "ReactionType" NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "reactions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bookmarks" (
    "id" UUID NOT NULL,
    "articleId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "bookmarks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pageVisits" (
    "id" UUID NOT NULL,
    "visitorId" UUID NOT NULL,
    "userId" UUID,
    "url" VARCHAR(2048) NOT NULL,
    "ipAddress" VARCHAR(45) NOT NULL,
    "geoLocation" JSONB,
    "device" TEXT NOT NULL,
    "browser" TEXT NOT NULL,
    "os" TEXT NOT NULL,
    "referrer" TEXT,
    "timestamp" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "pageVisits_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "visitorTracking" (
    "id" UUID NOT NULL,
    "trackingCode" UUID NOT NULL,
    "userId" UUID,
    "firstVisit" TIMESTAMPTZ(3) NOT NULL,
    "lastVisit" TIMESTAMPTZ(3) NOT NULL,
    "totalVisits" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "visitorTracking_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dailyStats" (
    "id" UUID NOT NULL,
    "date" DATE NOT NULL,
    "visits" INTEGER NOT NULL,
    "uniqueVisitors" INTEGER NOT NULL,
    "lastRollup" TIMESTAMPTZ(3),

    CONSTRAINT "dailyStats_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "aiSchedule" (
    "id" UUID NOT NULL,
    "daysOfWeek" INTEGER[],
    "time" TEXT NOT NULL,
    "timezone" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT false,
    "lastRun" TIMESTAMPTZ(3),
    "topicsToResearch" TEXT[],
    "nextRun" TIMESTAMPTZ(3),

    CONSTRAINT "aiSchedule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "aiSettings" (
    "id" TEXT NOT NULL DEFAULT 'ai_settings',
    "provider" TEXT NOT NULL,
    "apiKey" TEXT,
    "model" TEXT NOT NULL,
    "promptTemplate" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT false,
    "lastTested" TIMESTAMPTZ(3),
    "testStatus" "AiTestStatus",
    "isWriting" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3),

    CONSTRAINT "aiSettings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "articleViews" (
    "id" UUID NOT NULL,
    "articleId" UUID NOT NULL,
    "visitorId" UUID NOT NULL,
    "userId" UUID,
    "viewedAt" TIMESTAMPTZ(3) NOT NULL,
    "engagementTime" INTEGER,

    CONSTRAINT "articleViews_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "emailQueue" (
    "id" UUID NOT NULL,
    "recipient" VARCHAR(320) NOT NULL,
    "subject" TEXT NOT NULL,
    "templateName" TEXT NOT NULL,
    "templateData" JSONB NOT NULL,
    "status" "EmailQueueStatus" NOT NULL,
    "scheduledFor" TIMESTAMPTZ(3) NOT NULL,
    "sentAt" TIMESTAMPTZ(3),
    "error" TEXT,
    "retries" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "emailQueue_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "researchTopics" (
    "id" UUID NOT NULL,
    "topic" TEXT NOT NULL,
    "categoryId" UUID,
    "status" "ResearchTopicStatus" NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "researchTopics_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "adsSettings" (
    "id" TEXT NOT NULL DEFAULT 'ads_settings',
    "adsEnabled" BOOLEAN NOT NULL DEFAULT false,
    "adsenseScriptCode" TEXT NOT NULL,
    "adsenseAdUnitCode" TEXT NOT NULL,
    "showAdTopOfArticle" BOOLEAN NOT NULL DEFAULT false,
    "showAdMiddleOfArticle" BOOLEAN NOT NULL DEFAULT false,
    "showAdBottomOfArticle" BOOLEAN NOT NULL DEFAULT false,
    "showAdSidebar" BOOLEAN NOT NULL DEFAULT false,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "adsSettings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "siteSettings" (
    "id" TEXT NOT NULL DEFAULT 'site_settings',
    "siteName" TEXT NOT NULL,
    "siteDescription" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "phone" TEXT,
    "address" TEXT,
    "socials" JSONB NOT NULL,
    "footerText" TEXT,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "siteSettings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "otpCodes" (
    "id" UUID NOT NULL,
    "email" VARCHAR(320) NOT NULL,
    "code" VARCHAR(32) NOT NULL,
    "type" "OtpCodeType" NOT NULL,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "otpCodes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pillars" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "slug" VARCHAR(255) NOT NULL,
    "description" TEXT,
    "coverImage" TEXT,
    "pexelsImages" TEXT[],
    "categoryId" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "pillars_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE INDEX "users_role_idx" ON "users"("role");

-- CreateIndex
CREATE INDEX "users_confirmationToken_idx" ON "users"("confirmationToken");

-- CreateIndex
CREATE INDEX "users_resetToken_idx" ON "users"("resetToken");

-- CreateIndex
CREATE INDEX "quotes_createdAt_idx" ON "quotes"("createdAt" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "articles_slug_key" ON "articles"("slug");

-- CreateIndex
CREATE INDEX "articles_status_idx" ON "articles"("status");

-- CreateIndex
CREATE INDEX "articles_publishedAt_idx" ON "articles"("publishedAt" DESC);

-- CreateIndex
CREATE INDEX "articles_categoryId_idx" ON "articles"("categoryId");

-- CreateIndex
CREATE INDEX "articles_authorId_idx" ON "articles"("authorId");

-- CreateIndex
CREATE INDEX "articles_status_categoryId_idx" ON "articles"("status", "categoryId");

-- CreateIndex
CREATE INDEX "articles_pillar_idx" ON "articles"("pillar");

-- CreateIndex
CREATE UNIQUE INDEX "categories_slug_key" ON "categories"("slug");

-- CreateIndex
CREATE INDEX "comments_articleId_idx" ON "comments"("articleId");

-- CreateIndex
CREATE INDEX "comments_userId_idx" ON "comments"("userId");

-- CreateIndex
CREATE INDEX "comments_parentId_idx" ON "comments"("parentId");

-- CreateIndex
CREATE INDEX "reactions_userId_idx" ON "reactions"("userId");

-- CreateIndex
CREATE INDEX "reactions_createdAt_idx" ON "reactions"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "reactions_articleId_userId_key" ON "reactions"("articleId", "userId");

-- CreateIndex
CREATE INDEX "bookmarks_articleId_idx" ON "bookmarks"("articleId");

-- CreateIndex
CREATE UNIQUE INDEX "bookmarks_userId_articleId_key" ON "bookmarks"("userId", "articleId");

-- CreateIndex
CREATE INDEX "pageVisits_visitorId_idx" ON "pageVisits"("visitorId");

-- CreateIndex
CREATE INDEX "pageVisits_userId_idx" ON "pageVisits"("userId");

-- CreateIndex
CREATE INDEX "pageVisits_url_idx" ON "pageVisits"("url");

-- CreateIndex
CREATE INDEX "pageVisits_timestamp_idx" ON "pageVisits"("timestamp" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "visitorTracking_trackingCode_key" ON "visitorTracking"("trackingCode");

-- CreateIndex
CREATE INDEX "visitorTracking_userId_idx" ON "visitorTracking"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "dailyStats_date_key" ON "dailyStats"("date");

-- CreateIndex
CREATE INDEX "articleViews_userId_idx" ON "articleViews"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "articleViews_articleId_visitorId_key" ON "articleViews"("articleId", "visitorId");

-- CreateIndex
CREATE INDEX "emailQueue_status_scheduledFor_idx" ON "emailQueue"("status", "scheduledFor");

-- CreateIndex
CREATE INDEX "researchTopics_status_idx" ON "researchTopics"("status");

-- CreateIndex
CREATE INDEX "otpCodes_email_type_idx" ON "otpCodes"("email", "type");

-- CreateIndex
CREATE INDEX "otpCodes_code_idx" ON "otpCodes"("code");

-- CreateIndex
CREATE UNIQUE INDEX "pillars_slug_key" ON "pillars"("slug");

-- CreateIndex
CREATE INDEX "pillars_categoryId_idx" ON "pillars"("categoryId");

-- AddForeignKey
ALTER TABLE "articles" ADD CONSTRAINT "articles_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "articles" ADD CONSTRAINT "articles_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "categories"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "articles" ADD CONSTRAINT "articles_pillar_fkey" FOREIGN KEY ("pillar") REFERENCES "pillars"("slug") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "comments" ADD CONSTRAINT "comments_articleId_fkey" FOREIGN KEY ("articleId") REFERENCES "articles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "comments" ADD CONSTRAINT "comments_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "comments" ADD CONSTRAINT "comments_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "comments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reactions" ADD CONSTRAINT "reactions_articleId_fkey" FOREIGN KEY ("articleId") REFERENCES "articles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reactions" ADD CONSTRAINT "reactions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bookmarks" ADD CONSTRAINT "bookmarks_articleId_fkey" FOREIGN KEY ("articleId") REFERENCES "articles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bookmarks" ADD CONSTRAINT "bookmarks_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pageVisits" ADD CONSTRAINT "pageVisits_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "visitorTracking" ADD CONSTRAINT "visitorTracking_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "articleViews" ADD CONSTRAINT "articleViews_articleId_fkey" FOREIGN KEY ("articleId") REFERENCES "articles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "articleViews" ADD CONSTRAINT "articleViews_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "researchTopics" ADD CONSTRAINT "researchTopics_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "categories"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pillars" ADD CONSTRAINT "pillars_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

