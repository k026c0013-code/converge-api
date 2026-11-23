-- CreateTable
CREATE TABLE `document_updates` (
    `id` BIGINT NOT NULL AUTO_INCREMENT,
    `document_id` CHAR(36) NOT NULL,
    `update_id` CHAR(36) NOT NULL,
    `client_id` VARCHAR(64) NOT NULL,
    `user_id` CHAR(36) NOT NULL,
    `update_data` LONGBLOB NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `document_updates_document_id_id_idx`(`document_id`, `id`),
    UNIQUE INDEX `document_updates_document_id_update_id_key`(`document_id`, `update_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `document_updates` ADD CONSTRAINT `document_updates_document_id_fkey` FOREIGN KEY (`document_id`) REFERENCES `documents`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
