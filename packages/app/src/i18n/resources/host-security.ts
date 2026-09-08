export const hostSecurity = {
  en: {
    title: "Host security",
    required: "Supervised Teams require a saved host password.",
    environment: "Remove PASEO_PASSWORD from the host launcher and restart safely before setup.",
    unsupported:
      "Connect directly to the host with a current CC app and daemon to configure security.",
    setup: "Set up host security",
    codeHelp:
      "On the daemon host, run this from the CC checkout. Enter the private code within five minutes.",
    code: "Setup code",
    passwordHelp:
      "Use 12–72 characters: A–Z, a–z, 0–9, hyphen (-), underscore (_), dot (.), or tilde (~).",
    password: "Password",
    confirm: "Confirm password",
    save: "Save password",
    saved:
      "Password saved. Security takes effect after restarting. This connection will remember the password.",
    restart: "Restart host",
    restartWarning:
      "Restarting disconnects clients and interrupts active agents and Team Runs. Finish active work first. Restart now?",
    ready: "Host reconnected with security enabled.",
  },
  es: {
    title: "Seguridad del host",
    required: "Los equipos supervisados requieren una contraseña guardada del host.",
    environment: "Elimina PASEO_PASSWORD del inicio del host y reinícialo de forma segura.",
    unsupported: "Conecta directamente con una app y un daemon CC actualizados.",
    setup: "Configurar seguridad",
    codeHelp:
      "En el host del daemon, ejecuta esto desde el repositorio CC. Introduce el código privado en cinco minutos.",
    code: "Código de configuración",
    passwordHelp:
      "Usa entre 12 y 72 caracteres: A–Z, a–z, 0–9, guion (-), guion bajo (_), punto (.) o tilde (~).",
    password: "Contraseña",
    confirm: "Confirmar contraseña",
    save: "Guardar contraseña",
    saved:
      "Contraseña guardada. Reinicia para activar la seguridad. Esta conexión recordará la contraseña.",
    restart: "Reiniciar host",
    restartWarning:
      "El reinicio desconecta clientes e interrumpe agentes y ejecuciones de equipos activos. Termina el trabajo primero. ¿Reiniciar ahora?",
    ready: "Host reconectado con seguridad activada.",
  },
  fr: {
    title: "Sécurité de l’hôte",
    required: "Les Teams supervisées nécessitent un mot de passe enregistré.",
    environment: "Retirez PASEO_PASSWORD du lanceur et redémarrez l’hôte en toute sécurité.",
    unsupported: "Connectez-vous directement avec une app et un daemon CC à jour.",
    setup: "Configurer la sécurité",
    codeHelp:
      "Sur l’hôte du daemon, exécutez ceci depuis le dépôt CC. Saisissez le code privé sous cinq minutes.",
    code: "Code de configuration",
    passwordHelp:
      "Utilisez 12 à 72 caractères : A–Z, a–z, 0–9, tiret (-), soulignement (_), point (.) ou tilde (~).",
    password: "Mot de passe",
    confirm: "Confirmer le mot de passe",
    save: "Enregistrer",
    saved:
      "Mot de passe enregistré. Redémarrez pour activer la sécurité. Cette connexion le mémorisera.",
    restart: "Redémarrer l’hôte",
    restartWarning:
      "Le redémarrage déconnecte les clients et interrompt les agents et Teams actifs. Terminez le travail d’abord. Redémarrer maintenant ?",
    ready: "Hôte reconnecté avec la sécurité activée.",
  },
  ja: {
    title: "ホストのセキュリティ",
    required: "監督付きチームには保存済みのホストパスワードが必要です。",
    environment: "起動設定から PASEO_PASSWORD を削除し、安全に再起動してください。",
    unsupported: "最新の CC アプリとデーモンでホストに直接接続してください。",
    setup: "セキュリティを設定",
    codeHelp:
      "デーモンのホスト上で CC リポジトリから実行し、5分以内に非公開コードを入力してください。",
    code: "設定コード",
    passwordHelp:
      "12〜72文字で、A–Z、a–z、0–9、ハイフン (-)、アンダースコア (_)、ピリオド (.)、チルダ (~) を使用してください。",
    password: "パスワード",
    confirm: "パスワードの確認",
    save: "パスワードを保存",
    saved: "保存しました。再起動後に有効になります。この接続はパスワードを記憶します。",
    restart: "ホストを再起動",
    restartWarning:
      "再起動すると接続が切れ、実行中のエージェントとチームが中断されます。作業を終えてから再起動してください。今すぐ再起動しますか？",
    ready: "セキュリティを有効にして再接続しました。",
  },
  ko: {
    title: "호스트 보안",
    required: "감독 팀에는 저장된 호스트 비밀번호가 필요합니다.",
    environment: "호스트 실행 설정에서 PASEO_PASSWORD를 제거하고 안전하게 재시작하세요.",
    unsupported: "최신 CC 앱과 데몬으로 호스트에 직접 연결하세요.",
    setup: "보안 설정",
    codeHelp: "데몬 호스트의 CC 저장소에서 실행하고 5분 이내에 비공개 코드를 입력하세요.",
    code: "설정 코드",
    passwordHelp:
      "12~72자: A–Z, a–z, 0–9, 하이픈 (-), 밑줄 (_), 마침표 (.), 물결표 (~)를 사용하세요.",
    password: "비밀번호",
    confirm: "비밀번호 확인",
    save: "비밀번호 저장",
    saved: "저장했습니다. 재시작 후 보안이 적용됩니다. 이 연결은 비밀번호를 기억합니다.",
    restart: "호스트 재시작",
    restartWarning:
      "재시작하면 클라이언트 연결이 끊기고 실행 중인 에이전트와 팀이 중단됩니다. 작업을 먼저 마치세요. 지금 재시작할까요?",
    ready: "보안이 활성화된 호스트에 다시 연결했습니다.",
  },
  "pt-BR": {
    title: "Segurança do host",
    required: "Teams supervisionadas exigem uma senha salva do host.",
    environment: "Remova PASEO_PASSWORD da inicialização e reinicie o host com segurança.",
    unsupported: "Conecte diretamente com o app e daemon CC atualizados.",
    setup: "Configurar segurança",
    codeHelp:
      "No host do daemon, execute no repositório CC. Insira o código privado em até cinco minutos.",
    code: "Código de configuração",
    passwordHelp:
      "Use de 12 a 72 caracteres: A–Z, a–z, 0–9, hífen (-), sublinhado (_), ponto (.) ou til (~).",
    password: "Senha",
    confirm: "Confirmar senha",
    save: "Salvar senha",
    saved: "Senha salva. Reinicie para ativar a segurança. Esta conexão lembrará a senha.",
    restart: "Reiniciar host",
    restartWarning:
      "Reiniciar desconecta clientes e interrompe agentes e Teams ativos. Termine o trabalho primeiro. Reiniciar agora?",
    ready: "Host reconectado com segurança ativada.",
  },
  ru: {
    title: "Безопасность хоста",
    required: "Для команд с супервизором нужен сохранённый пароль хоста.",
    environment: "Удалите PASEO_PASSWORD из параметров запуска и безопасно перезапустите хост.",
    unsupported: "Подключитесь напрямую через актуальные приложение и демон CC.",
    setup: "Настроить безопасность",
    codeHelp:
      "На хосте демона выполните команду из репозитория CC. Введите секретный код в течение пяти минут.",
    code: "Код настройки",
    passwordHelp:
      "Используйте 12–72 символа: A–Z, a–z, 0–9, дефис (-), подчёркивание (_), точку (.) или тильду (~).",
    password: "Пароль",
    confirm: "Подтверждение пароля",
    save: "Сохранить пароль",
    saved:
      "Пароль сохранён. Безопасность включится после перезапуска. Подключение запомнит пароль.",
    restart: "Перезапустить хост",
    restartWarning:
      "Перезапуск отключает клиентов и прерывает активных агентов и команды. Сначала завершите работу. Перезапустить сейчас?",
    ready: "Хост подключён с включённой безопасностью.",
  },
  "zh-CN": {
    title: "主机安全",
    required: "受监督团队需要已保存的主机密码。",
    environment: "从主机启动配置中移除 PASEO_PASSWORD，然后安全地重启。",
    unsupported: "请使用最新的 CC 应用和守护进程直接连接主机。",
    setup: "设置主机安全",
    codeHelp: "在守护进程主机的 CC 仓库中运行此命令，并在五分钟内输入私密代码。",
    code: "设置代码",
    passwordHelp: "使用12–72个字符：A–Z、a–z、0–9、连字符 (-)、下划线 (_)、点 (.) 或波浪号 (~)。",
    password: "密码",
    confirm: "确认密码",
    save: "保存密码",
    saved: "密码已保存。重启后生效。此连接将记住密码。",
    restart: "重启主机",
    restartWarning: "重启会断开客户端并中断正在运行的代理和团队。请先完成工作。现在重启吗？",
    ready: "已重新连接到启用安全设置的主机。",
  },
  ar: {
    title: "أمان المضيف",
    required: "تتطلب الفرق الخاضعة للإشراف كلمة مرور محفوظة للمضيف.",
    environment: "أزل PASEO_PASSWORD من إعدادات التشغيل ثم أعد التشغيل بأمان.",
    unsupported: "اتصل مباشرة باستخدام تطبيق CC وخادم محدّثين.",
    setup: "إعداد أمان المضيف",
    codeHelp: "نفّذ الأمر من مستودع CC على مضيف الخادم وأدخل الرمز الخاص خلال خمس دقائق.",
    code: "رمز الإعداد",
    passwordHelp:
      "استخدم 12–72 محرفًا: A–Z أو a–z أو 0–9 أو الشرطة (-) أو الشرطة السفلية (_) أو النقطة (.) أو (~).",
    password: "كلمة المرور",
    confirm: "تأكيد كلمة المرور",
    save: "حفظ كلمة المرور",
    saved: "حُفظت كلمة المرور. يسري الأمان بعد إعادة التشغيل وسيتذكرها هذا الاتصال.",
    restart: "إعادة تشغيل المضيف",
    restartWarning:
      "تقطع إعادة التشغيل اتصالات العملاء وتوقف الوكلاء والفرق النشطة. أنهِ العمل أولاً. هل تريد إعادة التشغيل الآن؟",
    ready: "أُعيد الاتصال بالمضيف مع تفعيل الأمان.",
  },
};
