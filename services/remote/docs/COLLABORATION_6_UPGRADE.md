# collaboration.6 升级与回退

Station与Hub配套候选，保持MySQL5.7、station_hub、原HUB_SECRET、账号、设备和原业务表。仅增加collab_text_artifacts、collab_text_chunks；schema仍为2，不改写旧summary或历史验收事实。

先在维护窗口暂停新派发，使用原设备核对旧执行及在途Git的实际退出；旧客户端仍在处理的文字成果应先完成原协议交付，或明确保留其未完整状态，不强推新协议、不重跑模型补正文。随后备份数据库、配置、密钥与设备档案。运维DDL身份在已确认schema2上执行mysql57-upgrade/04-add-text-artifacts.sql，然后05核对表、列、主键、InnoDB与Dynamic/utf8mb4_bin；04可重跑，未知schema仅输出BLOCKED而不新增表。已有schema1先按01—03既有流程升级。运行账号继续DML权限，禁止临时授予DDL。先在隔离MySQL5.7实际验证，再按运维流程升级Hub与Station。保留.5安装器和所有原始证据。

新文字成果上限16MiB，32KiB原始字节片，HTTP JSON上限64000字节；不是附件服务。认证绑定owner/执行设备/task/attempt，全文校验后才交付与核验；超过限额或失败本机全文保留，不重新启动Agent。原附件、代码和选定文件仍通过用户指定GitHub仓库。旧客户端遇到新全文或范围能力收到426，不撤销身份，不重放模型。历史只有summary时显示完整性未证明，不能自动补造manifest；已验收历史不改写。

人工检查捕获准确attempt与成果SHA，review/integrate分阶段幂等。正常完成后stop仍可检查原成果；失败测试不因人工说明通过。明确范围修订同时更新目标和验收条件，保留旧版与成果，停止后仍需明确continue。

设备凭据新封装附用途/账号/设备/档案/键指纹，旧密文正常解密且服务身份核验后才迁移。无法解密时保留密文、任务和成果，正常登录不保证找回旧键；用户明确确认恢复时关闭接收并重新确认本机Agent/目录授权。此包不自动执行生产凭据恢复、清理Local State、撤销或配对。F09原始坏密文来源尚未知。

回退前进入maintenance并在原设备核对真实退出、在途Git、原attempt和完整成果。06是保留数据的核对材料，禁止删除新增表或用旧数据库覆盖新业务行。旧Hub/Station不能解释新manifest时保留数据并恢复匹配版本核对，不自动回滚Git、不清凭据。生产发布、真实双机/GitHub/Desktop/受影响档案恢复仅在授权与条件具备时验收；本轮本地夹具不替代它们。
