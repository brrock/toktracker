export const PageHeading = ({
  description,
  icon,
  title,
}: {
  description: string;
  icon?: React.ReactNode;
  title: string;
}) => (
  <>
    <div className="flex items-center gap-3">
      {icon}
      <h2 className="truncate text-2xl font-semibold tracking-tight">
        {title}
      </h2>
    </div>
    <p className="mt-1 text-sm text-muted-foreground">{description}</p>
  </>
);
