-- CreateTable
CREATE TABLE `document_snapshots` (
    `id` CHAR(36) NOT NULL,
    `document_id` CHAR(36) NOT NULL,
    `state_data` LONGBLOB NOT NULL,
    `last_update_id` BIGINT NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `document_snapshots_document_id_last_update_id_idx`(`document_id`, `last_update_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `document_versions` (
    `id` CHAR(36) NOT NULL,
    `document_id` CHAR(36) NOT NULL,
    `snapshot_id` CHAR(36) NOT NULL,
    `created_by` CHAR(36) NOT NULL,
    `name` VARCHAR(100) NOT NULL,
    `note` VARCHAR(500) NULL,
    `kind` VARCHAR(16) NOT NULL DEFAULT 'manual',
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `document_versions_document_id_created_at_idx`(`document_id`, `created_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `document_snapshots` ADD CONSTRAINT `document_snapshots_document_id_fkey` FOREIGN KEY (`document_id`) REFERENCES `documents`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `document_versions` ADD CONSTRAINT `document_versions_document_id_fkey` FOREIGN KEY (`document_id`) REFERENCES `documents`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `document_versions` ADD CONSTRAINT `document_versions_snapshot_id_fkey` FOREIGN KEY (`snapshot_id`) REFERENCES `document_snapshots`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
