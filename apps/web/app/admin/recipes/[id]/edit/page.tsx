import { RecipeEditForm } from "./RecipeEditForm";

export const metadata = {
  title: "Edit Recipe — UIU Admin",
};

export default async function RecipeEditPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <RecipeEditForm recipeId={id} />;
}
